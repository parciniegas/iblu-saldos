import * as amqplib from 'amqplib';
import pino from 'pino';
import type { MovimientoContableEvent } from '../../application/contracts/MovimientoContableEvent.js';
import type { MessageProcessor } from './MessageProcessor.js';
import { URL } from 'node:url';

export type RabbitMQConfig = {
  host: string;
  queueName: string;
  prefetch: number;
  retryAttempts: number;
  retryDelayMs: number;
};

const DEFAULT_CONFIG: RabbitMQConfig = {
  host: 'amqp://localhost',
  queueName: 'saldos_movimientos',
  prefetch: 1,
  retryAttempts: 3,
  retryDelayMs: 5000,
};

type Channel = amqplib.Channel;
type Connection = amqplib.Connection;
type ConsumeMessage = amqplib.ConsumeMessage;

export class RabbitMQConsumer {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private running = false;
  private readonly logger: pino.Logger;
  private readonly config: RabbitMQConfig;
  private readonly processor: MessageProcessor;

  constructor(config: Partial<RabbitMQConfig>, processor: MessageProcessor, logger: pino.Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.processor = processor;
    this.logger = logger;
  }

  async start(): Promise<void> {
    try {
      const sanitizedHost = this.sanitizeAmqpUrl(this.config.host);
      this.logger.info({ host: sanitizedHost }, '[RABBITMQ] Conectando a RabbitMQ');

      const conn = (await amqplib.connect(this.config.host)) as unknown as Connection;
      this.connection = conn as Connection;
      (this.connection as unknown as { on(event: string, cb: (err?: unknown) => void): void }).on('error', (err) => {
        this.logger.error({ error: err instanceof Error ? err.message : String(err) }, '[RABBITMQ] Error en la conexión');
      });
      (this.connection as unknown as { on(event: string, cb: () => void): void }).on('close', () => {
        this.running = false;
        this.logger.warn('[RABBITMQ] Conexión cerrada');
      });

      this.logger.info('[RABBITMQ] Creando canal');
      this.channel = (await (conn as unknown as { createChannel(): Promise<Channel> }).createChannel()) as Channel;
      (this.channel as unknown as { on(event: string, cb: (err?: unknown) => void): void }).on('error', (err) => {
        this.logger.error({ error: err instanceof Error ? err.message : String(err) }, '[RABBITMQ] Error en el canal');
      });
      (this.channel as unknown as { on(event: string, cb: () => void): void }).on('close', () => {
        this.logger.warn('[RABBITMQ] Canal cerrado');
      });

      this.logger.info({ queue: this.config.queueName }, '[RABBITMQ] Asegurando cola');
      await this.channel.assertQueue(this.config.queueName, {
        durable: true,
        arguments: {
          'x-message-ttl': 60000,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': `${this.config.queueName}.dlq`,
        },
      });

      this.logger.info({ prefetch: this.config.prefetch }, '[RABBITMQ] Configurando prefetch');
      await this.channel.prefetch(this.config.prefetch);

      this.logger.info({ queue: this.config.queueName }, '[RABBITMQ] Iniciando consumo');
      await this.channel.consume(
        this.config.queueName,
        async (msg: ConsumeMessage | null) => {
          if (!msg) return;
          await this.processMessage(msg);
        },
        { noAck: false },
      );

      this.running = true;
      this.logger.info({ queue: this.config.queueName, host: sanitizedHost }, '[RABBITMQ] Consumidor iniciado');
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        '[RABBITMQ] Error conectando a RabbitMQ',
      );
      throw error;
    }
  }

  private async processMessage(msg: ConsumeMessage): Promise<void> {
    try {
      const meta = this.messageMeta(msg);
      this.logger.info({ ...meta, size: msg.content.length }, '[RABBITMQ] Mensaje recibido');

      const started = Date.now();
      const payloadText = msg.content.toString();
      const content = JSON.parse(payloadText) as MovimientoContableEvent;
      this.logger.info({ ...meta, movimientoId: content.id, estado: content.Estado }, '[RABBITMQ] Procesando evento');
      await this.processor.process(content, 1000);
      const durationMs = Date.now() - started;
      this.channel?.ack(msg);
      this.logger.info({ ...meta, movimientoId: content.id, durationMs }, '[RABBITMQ] Mensaje ACK');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const meta = this.messageMeta(msg);
      this.logger.error({ ...meta, error: errorMessage }, '[RABBITMQ] Error procesando mensaje');

      const retryCount = this.getRetryCount(msg);

      if (retryCount < this.config.retryAttempts) {
        const delayMs = this.config.retryDelayMs * Math.pow(2, retryCount);
        this.logger.info({ ...meta, retryCount, delayMs }, '[RABBITMQ] Reintentando mensaje');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        this.channel?.nack(msg, false, true);
      } else {
        this.logger.warn({ ...meta }, '[RABBITMQ] Mensaje enviado a DLQ después de reintentos');
        this.channel?.nack(msg, false, false);
      }
    }
  }

  private getRetryCount(msg: ConsumeMessage): number {
    // Mejor esfuerzo: usa cabecera x-retries si existe; si no, usa bandera redelivered (0 o 1)
    const headers = (msg.properties && msg.properties.headers) || {};
    const headerRetry = (headers['x-retries'] as number | undefined) ?? undefined;
    if (typeof headerRetry === 'number' && Number.isFinite(headerRetry)) return headerRetry;
    return msg.fields.redelivered ? 1 : 0;
  }

  private messageMeta(msg: ConsumeMessage): Record<string, unknown> {
    return {
      deliveryTag: msg.fields.deliveryTag,
      redelivered: msg.fields.redelivered,
      exchange: msg.fields.exchange,
      routingKey: msg.fields.routingKey,
      messageId: msg.properties.messageId,
      correlationId: msg.properties.correlationId,
      timestamp: msg.properties.timestamp,
    };
  }

  private sanitizeAmqpUrl(urlStr: string): string {
    try {
      const u = new URL(urlStr);
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return urlStr.replace(/:\S+@/, ':***@');
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      if (this.channel) {
        await (this.channel as { close(): Promise<void> }).close();
      }
      if (this.connection) {
        await (this.connection as unknown as { close(): Promise<void> }).close();
      }
      this.logger.info('[RABBITMQ] Consumidor detenido');
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        '[RABBITMQ] Error cerrando conexión',
      );
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
