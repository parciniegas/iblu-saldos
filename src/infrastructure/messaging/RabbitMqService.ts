import { Client, type AmqpMessage, type Receiver, type Sender } from 'amqp10';
import pino from 'pino';

export type RabbitMqSettings = {
  hostName: string;
  port: number;
  userName: string;
  password: string;
  virtualHost: string;
  queueName: string;
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
  private client: Client | null = null;
  private sender: Sender | null = null;
  private receiver: Receiver | null = null;
  private logger: pino.Logger | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
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
    return `amqp://${this.settings.userName}:${this.settings.password}@${this.settings.hostName}:${this.settings.port}`;
  }

  private onSenderCreated(sender: Sender): void {
    this.sender = sender;
  }

  private onReceiverCreated(receiver: Receiver, resolve: () => void): void {
    this.receiver = receiver;
    this.logger?.info({ queueName: this.settings.queueName }, 'RabbitMQ consumiendo mensajes');
    resolve();
  }

  private onDisconnected(): void {
    this.logger?.warn('Desconectado de RabbitMQ, reintentando...');
    this.stats.disconnectEvents += 1;
    this.scheduleReconnect();
  }

  async connect(): Promise<void> {
    this.stats.connectAttempts += 1;

    try {
      this.client = new Client();

      this.client.on('client:errorReceived', (err: Error) => {
        this.logger?.error({ error: err.message }, 'Error de conexión RabbitMQ');
      });

      this.client.on('disconnected', () => {
        this.onDisconnected();
      });

      await this.client.connect(this.getConnectionString());

      this.stats.successfulConnections += 1;
      this.stats.lastConnectedAt = new Date().toISOString();
      this.logger?.info({ queueName: this.settings.queueName }, 'RabbitMQ conectado');

      const sender = await this.client.createSender(this.settings.queueName);
      this.onSenderCreated(sender);

      const receiver = await this.client.createReceiver(this.settings.queueName);
      await new Promise<void>((resolve) => {
        this.onReceiverCreated(receiver, resolve);
      });
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
    const sender = this.sender;
    if (!sender) {
      throw new Error('RabbitMQ no conectado. Llama connect() primero.');
    }

    const address = queueName || this.settings.queueName;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stats.publishTimeouts += 1;
        reject(new Error('Timeout publicando mensaje'));
      }, 5000);

      sender.send(JSON.stringify(message)).then(() => {
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
    if (!this.receiver) {
      throw new Error('RabbitMQ no conectado. Llama connect() primero.');
    }

    this.receiver.on('message', async (message: AmqpMessage) => {
      try {
        this.stats.consumedCount += 1;
        const body = message.body;
        const payload = body instanceof Buffer ? body.toString('utf-8') : body;
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;

        await handler(parsed);

        if (this.receiver) {
          this.receiver.accept(message);
        }
      } catch (error) {
        this.stats.consumeErrors += 1;
        this.logger?.error({ error: error instanceof Error ? error.message : String(error) }, 'Error procesando mensaje');
        if (this.receiver) {
          this.receiver.accept(message);
        }
      }
    });
  }

  getStats(): RabbitMqRuntimeStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (this.client) {
        await this.client.disconnect();
      }
    } catch {
      // Ignore errors on close
    }

    this.logger?.info('RabbitMQ desconectado');
  }
}
