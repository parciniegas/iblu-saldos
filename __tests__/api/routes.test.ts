import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerHealthRoutes } from '../../src/api/routes/health.js';
import { registerSaldosRoutes } from '../../src/api/routes/saldos.js';
import { loadConfig } from '../../src/api/config.js';

describe('API routes', () => {
  it('debe reportar health detailed con base de datos conectada y rabbitMQ desconectado', async () => {
    const app = Fastify();
    const prismaClientMock = {
      $queryRaw: vi.fn().mockResolvedValue(1),
    };

    app.decorate('prismaClient', prismaClientMock as any);

    registerHealthRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health/detailed',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.rabbitMq).toBe('disconnected');
    expect(prismaClientMock.$queryRaw).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('debe responder 503 en /queue cuando RabbitMQ no esta disponible', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';

    app.decorate('config', config);

    registerSaldosRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/saldos/queue',
      headers: {
        'x-api-key': apiKey,
      },
      payload: {
        fechaDesde: '2024-01-01',
        batchSize: 1000,
      },
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error).toBe('RabbitMQ no disponible');

    await app.close();
  });

  it('debe exponer métricas de jobs en /api/v1/saldos/jobs/metrics', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';

    app.decorate('config', config);

    registerSaldosRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/saldos/jobs/metrics',
      headers: {
        'x-api-key': apiKey,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBeTypeOf('number');
    expect(body.pending).toBeTypeOf('number');
    expect(body.processing).toBeTypeOf('number');
    expect(body.completed).toBeTypeOf('number');
    expect(body.failed).toBeTypeOf('number');

    await app.close();
  });

  it('debe exponer rabbitMqStats en health detailed cuando RabbitMQ está disponible', async () => {
    const app = Fastify();
    const prismaClientMock = {
      $queryRaw: vi.fn().mockResolvedValue(1),
    };
    const rabbitMqServiceMock = {
      getStats: vi.fn().mockReturnValue({
        connectAttempts: 1,
        successfulConnections: 1,
        disconnectEvents: 0,
        reconnectsScheduled: 0,
        publishedCount: 5,
        publishErrors: 0,
        publishTimeouts: 0,
        consumedCount: 3,
        consumeErrors: 0,
      }),
    };

    app.decorate('prismaClient', prismaClientMock as any);
    app.decorate('rabbitMqService', rabbitMqServiceMock as any);

    registerHealthRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health/detailed',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rabbitMq).toBe('connected');
    expect(body.rabbitMqStats.publishedCount).toBe(5);
    expect(rabbitMqServiceMock.getStats).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('debe exponer métricas operativas en /health/metrics', async () => {
    const app = Fastify();
    const rabbitMqServiceMock = {
      getStats: vi.fn().mockReturnValue({
        connectAttempts: 2,
        successfulConnections: 1,
        disconnectEvents: 1,
        reconnectsScheduled: 1,
        publishedCount: 10,
        publishErrors: 1,
        publishTimeouts: 0,
        consumedCount: 8,
        consumeErrors: 2,
      }),
    };

    app.decorate('prismaClient', { $queryRaw: vi.fn().mockResolvedValue(1) } as any);
    app.decorate('rabbitMqService', rabbitMqServiceMock as any);

    registerHealthRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health/metrics',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rabbitMq.connectAttempts).toBe(2);
    expect(body.rabbitMq.consumeErrors).toBe(2);
    expect(rabbitMqServiceMock.getStats).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
