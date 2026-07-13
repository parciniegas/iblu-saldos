import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerHealthRoutes } from '../../src/api/routes/health.js';
import { registerSaldosRoutes } from '../../src/api/routes/saldos.js';
import { loadConfig } from '../../src/api/config.js';

describe('API routes', () => {
  it('debe reportar health detailed con base de datos conectada', async () => {
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
    expect(prismaClientMock.$queryRaw).toHaveBeenCalledTimes(1);

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

  it('debe exponer métricas operativas en /health/metrics', async () => {
    const app = Fastify();

    app.decorate('prismaClient', { $queryRaw: vi.fn().mockResolvedValue(1) } as any);

    registerHealthRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health/metrics',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.database).toBe('connected');

    await app.close();
  });
});
