import * as amqplib from 'amqplib';
import pino from 'pino';
import type { MovimientoContableEvent } from '../../application/contracts/MovimientoContableEvent.js';
import type { MessageProcessor } from './MessageProcessor.js';

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
      const conn = (await amqplib.connect(this.config.host)) as unknown as Connection;
      this.connection = conn as Connection;
      this.channel = (await (conn as unknown as { createChannel(): Promise<Channel> }).createChannel()) as Channel;

      await this.channel.assertQueue(this.config.queueName, {
        durable: true,
        arguments: {
          'x-message-ttl': 60000,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': `${this.config.queueName}.dlq`,
        },
      });

      await this.channel.prefetch(this.config.prefetch);

      this.channel.consume(
        this.config.queueName,
        async (msg: ConsumeMessage | null) => {
          if (!msg) return;
          await this.processMessage(msg);
        },
        { noAck: false },
      );

      this.running = true;
      this.logger.info({ queue: this.config.queueName }, '[RABBITMQ] Consumidor iniciado');
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
      const content = JSON.parse(msg.content.toString()) as MovimientoContableEvent;
      this.logger.info({ movimientoId: content.id }, '[RABBITMQ] Procesando mensaje de RabbitMQ');
      await this.processor.process(content, 1000);
      this.channel?.ack(msg);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { error: errorMessage, contenido: msg.content.toString() },
        '[RABBITMQ] Error procesando mensaje',
      );

      const retryCount = this.getRetryCount();

      if (retryCount < this.config.retryAttempts) {
        const delayMs = this.config.retryDelayMs * Math.pow(2, retryCount);
        this.logger.info({ retryCount, delayMs }, '[RABBITMQ] Reintentando mensaje');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        this.channel?.nack(msg, false, true);
      } else {
        this.logger.warn({ movimientoId: msg.content.toString() }, '[RABBITMQ] Mensaje enviado a DLQ después de reintentos');
        this.channel?.nack(msg, false, false);
      }
    }
  }

  private getRetryCount(): number {
    return 0;
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
