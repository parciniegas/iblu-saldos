declare module 'amqp10' {
  export const Transport: {
    tls(): unknown;
  };

  export type SessionOptions = {
    settleSelfAck?: boolean;
  };

  export type SessionCreateOptions = {
    autoAttach?: boolean;
  };

  export type Delivery = {
    tag: Buffer;
    payload: Buffer;
  };

  export type AmqpMessage = {
    body: unknown;
  };

  export interface Sender {
    send(delivery: Delivery, callback: (err: Error | null, deliveryResult: unknown) => void): void;
  }

  export interface Receiver {
    on(event: 'message', handler: (message: AmqpMessage) => void | Promise<void>): void;
    ack(message: AmqpMessage): void;
  }

  export interface Session {
    once(event: 'senderCreated', handler: (sender: Sender) => void): void;
    once(event: 'receiverCreated', handler: (receiver: Receiver) => void): void;
    createSender(): void;
    createReceiver(address: string): void;
    close(): Promise<void>;
  }

  export class Client {
    constructor(transport: unknown, connectionString: string);
    on(event: 'connected', handler: () => void): void;
    on(event: 'error', handler: (err: Error) => void): void;
    on(event: 'disconnected', handler: () => void): void;
    once(event: 'sessionCreated', handler: (session: Session) => void): void;
    createSession(options?: SessionOptions, createOptions?: SessionCreateOptions): void;
    close(): Promise<void>;
  }
}
