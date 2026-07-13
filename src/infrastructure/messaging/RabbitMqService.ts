// @ts-ignore - amqp10 lacks type definitions
import * as amqp from 'amqp10';
// @ts-ignore - amqp10 lacks type definitions
import { Client } from 'amqp10';
import pino from 'pino';

export type RabbitMqSettings = {
  hostName: string;
  port: number;
  userName: string;
  password: string;
  virtualHost: string;
  queueName: string;
};

export interface IRabbitMqService {
  publish(queueName: string, message: object): Promise<void>;
  consume(queueName: string, handler: (message: any) => Promise<void>): Promise<void>;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export class RabbitMqServiceImpl implements IRabbitMqService {
  private client: Client | null = null;
  private session: any = null;
  private sender: any = null;
  private receiver: any = null;
  private logger: pino.Logger | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private settings: RabbitMqSettings) {}

  setLogger(log: pino.Logger): void {
    this.logger = log;
  }

  private getConnectionString(): string {
    return `amqp://${this.settings.userName}:${this.settings.password}@${this.settings.hostName}:${this.settings.port}`;
  }

  async connect(): Promise<void> {
    const self = this;

    try {
      this.client = new Client(amqp.Transport.tls(), this.getConnectionString());

      await new Promise<void>((resolve, reject) => {
        this.client!.on('connected', () => {
          self.logger?.info({ queueName: self.settings.queueName }, 'RabbitMQ conectado');

          this.client!.once('sessionCreated', (session: any) => {
            self.session = session;

            session.once('senderCreated', (sender: any) => {
              self.sender = sender;
            });

            session.once('receiverCreated', (receiver: any) => {
              self.receiver = receiver;
              self.logger?.info({ queueName: self.settings.queueName }, 'RabbitMQ consumiendo mensajes');
              resolve();
            });

            session.createSender();
            session.createReceiver(self.settings.queueName);
          });

          this.client!.createSession({
            settleSelfAck: true,
          }, { autoAttach: true });
        });

        this.client!.on('error', (err: Error) => {
          self.logger?.error({ error: err.message }, 'Error de conexión RabbitMQ');
          reject(err);
        });

        this.client!.on('disconnected', () => {
          self.logger?.warn('Desconectado de RabbitMQ, reintentando...');
          self.scheduleReconnect();
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
    if (!this.sender) {
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
        reject(new Error('Timeout publicando mensaje'));
      }, 5000);

      this.sender.send(delivery, (err: Error | null, _deliveryResult: any) => {
        clearTimeout(timeout);
        if (err) {
          this.logger?.error({ error: err.message }, 'Error publicando mensaje');
          reject(err);
        } else {
          this.logger?.debug({ queue: address }, 'Mensaje publicado a RabbitMQ');
          resolve();
        }
      });
    });
  }

  async consume(_queueName: string, handler: (message: any) => Promise<void>): Promise<void> {
    if (!this.receiver) {
      throw new Error('RabbitMQ no conectado. Llama connect() primero.');
    }

    this.receiver.on('message', async (message: any) => {
      try {
        const body = message.body;
        const text = body instanceof Buffer ? body.toString('utf-8') : String(body);
        const parsed = JSON.parse(text);

        await handler(parsed);

        if (this.receiver) {
          this.receiver.ack(message);
        }
      } catch (error) {
        this.logger?.error({ error: error instanceof Error ? error.message : String(error) }, 'Error procesando mensaje');
        if (this.receiver) {
          this.receiver.ack(message);
        }
      }
    });
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
