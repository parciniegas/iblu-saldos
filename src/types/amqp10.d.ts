declare module 'amqp10' {
  export type AmqpMessage = {
    body: unknown;
    _deliveryId?: number;
  };

  export interface Sender {
    send(message: unknown): Promise<unknown>;
  }

  export interface Receiver {
    on(event: 'message', handler: (message: AmqpMessage) => void | Promise<void>): void;
    accept(message: AmqpMessage): void;
  }

  export class Client {
    constructor(policy?: unknown, policyOverrides?: unknown);
    connect(url: string, policyOverrides?: unknown): Promise<void>;
    on(event: 'connected', handler: () => void): void;
    on(event: 'client:errorReceived', handler: (err: Error) => void): void;
    on(event: 'disconnected', handler: () => void): void;
    createSender(address: string, policyOverrides?: unknown): Promise<Sender>;
    createReceiver(address: string, policyOverrides?: unknown): Promise<Receiver>;
    disconnect(): Promise<void>;
  }
}
