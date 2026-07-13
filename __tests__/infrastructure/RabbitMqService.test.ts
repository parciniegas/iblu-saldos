import { beforeEach, describe, expect, it, vi } from 'vitest';

type MessageHandler = (message: { content: Buffer } | null) => void | Promise<void>;

const mocks = vi.hoisted(() => {
  const state = {
    messageHandler: null as MessageHandler | null,
    channel: {
      assertQueue: vi.fn(),
      prefetch: vi.fn(),
      consume: vi.fn(),
      sendToQueue: vi.fn(),
      ack: vi.fn(),
      once: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    },
    connection: {
      on: vi.fn(),
      createChannel: vi.fn(),
      close: vi.fn(),
    },
    connect: vi.fn(),
  };

  const reset = () => {
    state.messageHandler = null;

    state.channel.assertQueue = vi.fn().mockResolvedValue(undefined);
    state.channel.prefetch = vi.fn().mockResolvedValue(undefined);
    state.channel.consume = vi.fn().mockImplementation((_queue: string, handler: MessageHandler) => {
      state.messageHandler = handler;
      return Promise.resolve({ consumerTag: 'ctag-1' });
    });
    state.channel.sendToQueue = vi.fn().mockReturnValue(true);
    state.channel.ack = vi.fn();
    state.channel.once = vi.fn();
    state.channel.cancel = vi.fn().mockResolvedValue(undefined);
    state.channel.close = vi.fn().mockResolvedValue(undefined);

    state.connection.on = vi.fn();
    state.connection.createChannel = vi.fn().mockResolvedValue(state.channel);
    state.connection.close = vi.fn().mockResolvedValue(undefined);

    state.connect = vi.fn().mockResolvedValue(state.connection);
  };

  reset();

  return {
    state,
    reset,
  };
});

vi.mock('amqplib', () => ({
  default: {
    connect: (...args: unknown[]) => mocks.state.connect(...args),
  },
  connect: (...args: unknown[]) => mocks.state.connect(...args),
}));

import { RabbitMqServiceImpl } from '../../src/infrastructure/messaging/RabbitMqService.js';

function createService(): RabbitMqServiceImpl {
  return new RabbitMqServiceImpl({
    hostName: 'docker',
    port: 5672,
    userName: 'admin',
    password: 'P2ssw0rd',
    virtualHost: '/',
    queueName: 'saldos',
  });
}

describe('RabbitMqServiceImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it('debe conectar y publicar mensajes serializados', async () => {
    const service = createService();

    await service.connect();

    expect(mocks.state.connect).toHaveBeenCalledTimes(1);
    expect(mocks.state.connect).toHaveBeenCalledWith('amqp://admin:P2ssw0rd@docker:5672/%2F');
    expect(mocks.state.connection.createChannel).toHaveBeenCalledTimes(1);
    expect(mocks.state.channel.assertQueue).toHaveBeenCalledWith('saldos', { durable: false });

    await service.publish('saldos', { jobId: '123' });

    expect(mocks.state.channel.sendToQueue).toHaveBeenCalledWith(
      'saldos',
      Buffer.from('{"jobId":"123"}', 'utf-8'),
      { persistent: true, contentType: 'application/json' },
    );
    expect(service.getStats().publishedCount).toBe(1);
  });

  it('debe consumir mensajes y confirmarlos', async () => {
    const service = createService();
    const handler = vi.fn().mockResolvedValue(undefined);

    await service.connect();
    await service.consume('saldos', handler);

    expect(mocks.state.channel.consume).toHaveBeenCalledWith('saldos', expect.any(Function), { noAck: false });
    expect(mocks.state.messageHandler).not.toBeNull();

    await mocks.state.messageHandler?.({ content: Buffer.from('{"jobId":"abc"}', 'utf-8') });

    expect(handler).toHaveBeenCalledWith({ jobId: 'abc' });
    expect(mocks.state.channel.ack).toHaveBeenCalledTimes(1);
    expect(service.getStats().consumedCount).toBe(1);
  });
});
