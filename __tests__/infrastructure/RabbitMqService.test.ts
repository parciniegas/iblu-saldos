import { beforeEach, describe, expect, it, vi } from 'vitest';

type MessageHandler = (message: { body: unknown }) => void | Promise<void>;

const mocks = vi.hoisted(() => {
  const state = {
    messageHandler: null as MessageHandler | null,
    sender: {
      send: vi.fn(),
    },
    receiver: {
      on: vi.fn(),
      accept: vi.fn(),
    },
    client: {
      on: vi.fn(),
      connect: vi.fn(),
      createSender: vi.fn(),
      createReceiver: vi.fn(),
      disconnect: vi.fn(),
    },
  };

  const ClientMock = vi.fn();

  const reset = () => {
    state.messageHandler = null;

    state.sender.send = vi.fn().mockResolvedValue(undefined);

    state.receiver.on = vi.fn((event: string, handler: MessageHandler) => {
      if (event === 'message') {
        state.messageHandler = handler;
      }
    });
    state.receiver.accept = vi.fn();

    state.client.on = vi.fn();
    state.client.connect = vi.fn().mockResolvedValue(undefined);
    state.client.createSender = vi.fn().mockResolvedValue(state.sender);
    state.client.createReceiver = vi.fn().mockResolvedValue(state.receiver);
    state.client.disconnect = vi.fn().mockResolvedValue(undefined);

    ClientMock.mockReset();
    ClientMock.mockImplementation(() => state.client);
  };

  reset();

  return {
    state,
    ClientMock,
    reset,
  };
});

vi.mock('amqp10', () => ({
  Client: mocks.ClientMock,
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

    expect(mocks.ClientMock).toHaveBeenCalledTimes(1);
    expect(mocks.state.client.connect).toHaveBeenCalledWith('amqp://admin:P2ssw0rd@docker:5672');
    expect(mocks.state.client.createSender).toHaveBeenCalledWith('saldos');
    expect(mocks.state.client.createReceiver).toHaveBeenCalledWith('saldos');

    await service.publish('saldos', { jobId: '123' });

    expect(mocks.state.sender.send).toHaveBeenCalledWith('{"jobId":"123"}');
    expect(service.getStats().publishedCount).toBe(1);
  });

  it('debe consumir mensajes y confirmarlos', async () => {
    const service = createService();
    const handler = vi.fn().mockResolvedValue(undefined);

    await service.connect();
    await service.consume('saldos', handler);

    expect(mocks.state.receiver.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mocks.state.messageHandler).not.toBeNull();

    await mocks.state.messageHandler?.({ body: '{"jobId":"abc"}' });

    expect(handler).toHaveBeenCalledWith({ jobId: 'abc' });
    expect(mocks.state.receiver.accept).toHaveBeenCalledTimes(1);
    expect(service.getStats().consumedCount).toBe(1);
  });
});
