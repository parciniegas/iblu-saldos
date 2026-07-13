import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import pino from 'pino';

export type RabbitMqSettings = {
  hostName: string;
  port: number;
  userName: string;
  password: string;
  virtualHost: string;
  queueName: string;
  durable?: boolean;
};

export type RabbitMqRuntimeStats = {
  connectAttempts: number;
  successfulConnections: number;
  disconnectEvents: number;
  reconnectsScheduled: number;
  publishedCount: number;
  publishErrors: number;
  publishTimeouts: number;
  consumedCount: number;
  consumeErrors: number;
  lastConnectedAt?: string;
};

export interface IRabbitMqService {
  publish(queueName: string, message: object): Promise<void>;
  consume(queueName: string, handler: (message: unknown) => Promise<void>): Promise<void>;
  connect(): Promise<void>;
  getStats(): RabbitMqRuntimeStats;
  close(): Promise<void>;
}

export class RabbitMqServiceImpl implements IRabbitMqService {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private logger: pino.Logger | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private consumerTag: string | null = null;
  private isShuttingDown = false;
  private consumeQueueName: string | null = null;
  private consumeHandler: ((message: unknown) => Promise<void>) | null = null;
  private readonly stats: RabbitMqRuntimeStats = {
    connectAttempts: 0,
    successfulConnections: 0,
    disconnectEvents: 0,
    reconnectsScheduled: 0,
    publishedCount: 0,
    publishErrors: 0,
    publishTimeouts: 0,
    consumedCount: 0,
    consumeErrors: 0,
  };

  constructor(private readonly settings: RabbitMqSettings) {}

  setLogger(log: pino.Logger): void {
    this.logger = log;
  }

  private getConnectionString(): string {
    const virtualHost = this.settings.virtualHost && this.settings.virtualHost.trim().length > 0
      ? this.settings.virtualHost
      : '/';
    const normalizedVHost = virtualHost.startsWith('/') ? virtualHost : `/${virtualHost}`;
    const encodedVHost = normalizedVHost === '/' ? '%2F' : encodeURIComponent(normalizedVHost.slice(1));
    return `amqp://${encodeURIComponent(this.settings.userName)}:${encodeURIComponent(this.settings.password)}@${this.settings.hostName}:${this.settings.port}/${encodedVHost}`;
  }

  private onDisconnected(): void {
    if (this.isShuttingDown) return;

    this.logger?.warn('Desconectado de RabbitMQ, reintentando...');
    this.stats.disconnectEvents += 1;
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
    this.scheduleReconnect();
  }

  private async ensureQueue(queueName: string): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel no disponible. Llama connect() primero.');
    }

    await this.channel.assertQueue(queueName, {
      durable: this.settings.durable ?? false,
    });
  }

  private async startConsumerIfConfigured(): Promise<void> {
    if (!this.channel || !this.consumeHandler || !this.consumeQueueName) return;

    await this.ensureQueue(this.consumeQueueName);
    await this.channel.prefetch(1);

    const consumeResult = await this.channel.consume(this.consumeQueueName, async (message: ConsumeMessage | null) => {
      if (!message) return;

      try {
        this.stats.consumedCount += 1;
        const payload = message.content.toString('utf-8');
        const parsed = payload.length > 0 ? JSON.parse(payload) : null;

        await this.consumeHandler?.(parsed);
        this.channel?.ack(message);
      } catch (error) {
        this.stats.consumeErrors += 1;
        this.logger?.error({ error: error instanceof Error ? error.message : String(error) }, 'Error procesando mensaje');
        this.channel?.ack(message);
      }
    }, {
      noAck: false,
    });

    this.consumerTag = consumeResult.consumerTag;
    this.logger?.info({ queueName: this.consumeQueueName }, 'RabbitMQ consumiendo mensajes');
  }

  async connect(): Promise<void> {
    this.stats.connectAttempts += 1;
    this.isShuttingDown = false;

    try {
      if (this.connection) {
        try {
          await this.connection.close();
        } catch {
          // ignore
        }
      }

      this.connection = await amqp.connect(this.getConnectionString());
      this.connection.on('error', (err: Error) => {
        this.logger?.error({ error: err.message }, 'Error de conexión RabbitMQ');
      });
      this.connection.on('close', () => {
        this.onDisconnected();
      });

      this.channel = await this.connection.createChannel();
      await this.ensureQueue(this.settings.queueName);

      this.stats.successfulConnections += 1;
      this.stats.lastConnectedAt = new Date().toISOString();
      this.logger?.info({ queueName: this.settings.queueName }, 'RabbitMQ conectado');

      await this.startConsumerIfConfigured();
    } catch (error) {
      this.logger?.error({ error: error instanceof Error ? error.message : String(error) }, 'Error conectando a RabbitMQ');
      this.scheduleReconnect();
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.stats.reconnectsScheduled += 1;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, 5000);
  }

  async publish(queueName: string, message: object): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ no conectado. Llama connect() primero.');
    }

    const address = queueName || this.settings.queueName;
    await this.ensureQueue(address);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stats.publishTimeouts += 1;
        reject(new Error('Timeout publicando mensaje'));
      }, 5000);

      const payload = Buffer.from(JSON.stringify(message), 'utf-8');
      const sent = this.channel?.sendToQueue(address, payload, {
        persistent: true,
        contentType: 'application/json',
      }) ?? false;

      if (!sent && this.channel) {
        this.channel.once('drain', () => {
          clearTimeout(timeout);
          this.stats.publishedCount += 1;
          this.logger?.debug({ queue: address }, 'Mensaje publicado a RabbitMQ');
          resolve();
        });
        return;
      }

      Promise.resolve().then(() => {
        clearTimeout(timeout);
        this.stats.publishedCount += 1;
        this.logger?.debug({ queue: address }, 'Mensaje publicado a RabbitMQ');
        resolve();
      }).catch((err: unknown) => {
        clearTimeout(timeout);
        if (err instanceof Error) {
          this.stats.publishErrors += 1;
          this.logger?.error({ error: err.message }, 'Error publicando mensaje');
          reject(err);
        } else {
          this.stats.publishErrors += 1;
          reject(new Error(String(err)));
        }
      });
    });
  }

  async consume(_queueName: string, handler: (message: unknown) => Promise<void>): Promise<void> {
    this.consumeQueueName = _queueName || this.settings.queueName;
    this.consumeHandler = handler;

    if (!this.channel) {
      throw new Error('RabbitMQ no conectado. Llama connect() primero.');
    }

    await this.startConsumerIfConfigured();
  }

  getStats(): RabbitMqRuntimeStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (this.channel && this.consumerTag) {
        await this.channel.cancel(this.consumerTag);
      }
      this.consumerTag = null;

      if (this.channel) {
        await this.channel.close();
      }

      if (this.connection) {
        await this.connection.close();
      }
    } catch {
      // Ignore errors on close
    }

    this.channel = null;
    this.connection = null;

    this.logger?.info('RabbitMQ desconectado');
  }
}
