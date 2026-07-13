import * as amqp from 'amqp10';
import { Client, type AmqpMessage, type Receiver, type Sender, type Session } from 'amqp10';
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
  private session: Session | null = null;
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

  private onSessionCreated(session: Session, resolve: () => void): void {
    this.session = session;

    session.once('senderCreated', (sender: Sender) => {
      this.onSenderCreated(sender);
    });

    session.once('receiverCreated', (receiver: Receiver) => {
      this.onReceiverCreated(receiver, resolve);
    });

    session.createSender();
    session.createReceiver(this.settings.queueName);
  }

  private onConnected(resolve: () => void): void {
    this.logger?.info({ queueName: this.settings.queueName }, 'RabbitMQ conectado');
    this.stats.successfulConnections += 1;
    this.stats.lastConnectedAt = new Date().toISOString();

    this.client!.once('sessionCreated', (session: Session) => {
      this.onSessionCreated(session, resolve);
    });

    this.client!.createSession({
      settleSelfAck: true,
    }, { autoAttach: true });
  }

  private onConnectionError(err: Error, reject: (reason?: unknown) => void): void {
    this.logger?.error({ error: err.message }, 'Error de conexión RabbitMQ');
    reject(err);
  }

  private onDisconnected(): void {
    this.logger?.warn('Desconectado de RabbitMQ, reintentando...');
    this.stats.disconnectEvents += 1;
    this.scheduleReconnect();
  }

  async connect(): Promise<void> {
    this.stats.connectAttempts += 1;

    try {
      this.client = new Client(amqp.Transport.tls(), this.getConnectionString());

      await new Promise<void>((resolve, reject) => {
        this.client!.on('connected', () => {
          this.onConnected(resolve);
        });

        this.client!.on('error', (err: Error) => {
          this.onConnectionError(err, reject);
        });

        this.client!.on('disconnected', () => {
          this.onDisconnected();
        });
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
    const payload = Buffer.from(JSON.stringify(message));

    const tag = Buffer.alloc(8);
    tag.writeBigInt64BE(BigInt(Date.now()));

    const delivery = {
      tag,
      payload,
    };

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stats.publishTimeouts += 1;
        reject(new Error('Timeout publicando mensaje'));
      }, 5000);

      sender.send(delivery, (err: Error | null, _deliveryResult: unknown) => {
        clearTimeout(timeout);
        if (err) {
          this.stats.publishErrors += 1;
          this.logger?.error({ error: err.message }, 'Error publicando mensaje');
          reject(err);
        } else {
          this.stats.publishedCount += 1;
          this.logger?.debug({ queue: address }, 'Mensaje publicado a RabbitMQ');
          resolve();
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
        const text = body instanceof Buffer ? body.toString('utf-8') : String(body);
        const parsed = JSON.parse(text);

        await handler(parsed);

        if (this.receiver) {
          this.receiver.ack(message);
        }
      } catch (error) {
        this.stats.consumeErrors += 1;
        this.logger?.error({ error: error instanceof Error ? error.message : String(error) }, 'Error procesando mensaje');
        if (this.receiver) {
          this.receiver.ack(message);
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
      if (this.session) {
        await this.session.close();
      }
      if (this.client) {
        await this.client.close();
      }
    } catch {
      // Ignore errors on close
    }

    this.logger?.info('RabbitMQ desconectado');
  }
}
