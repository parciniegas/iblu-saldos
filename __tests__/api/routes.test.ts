import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { registerHealthRoutes } from '../../src/api/routes/health.js';
import { registerSaldosRoutes } from '../../src/api/routes/saldos.js';
import { loadConfig } from '../../src/api/config.js';

describe('API routes', () => {
  let previousStorePath: string | undefined;
  let isolatedStorePath: string;

  beforeEach(() => {
    previousStorePath = process.env.SALDOS_JOB_STORE_PATH;
    isolatedStorePath = path.join(os.tmpdir(), `saldos-jobs-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    process.env.SALDOS_JOB_STORE_PATH = isolatedStorePath;
  });

  afterEach(() => {
    if (previousStorePath === undefined) {
      delete process.env.SALDOS_JOB_STORE_PATH;
    } else {
      process.env.SALDOS_JOB_STORE_PATH = previousStorePath;
    }

    if (fs.existsSync(isolatedStorePath)) {
      fs.unlinkSync(isolatedStorePath);
    }
  });

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

  it('debe rechazar /procesar cuando ya existe un job en ejecución', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';

    app.decorate('config', config);
    app.decorate('useCase', {
      execute: vi.fn().mockImplementation(() => new Promise(() => {
        // job deliberadamente en ejecución para validar bloqueo.
      })),
    } as any);

    registerSaldosRoutes(app);

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/saldos/procesar',
      headers: { 'x-api-key': apiKey },
      payload: { fechaDesde: '2024-01-01', batchSize: 1000 },
    });

    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/saldos/procesar',
      headers: { 'x-api-key': apiKey },
      payload: { fechaDesde: '2024-01-01', batchSize: 1000 },
    });

    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error).toContain('job en ejecución');
    expect(body.runningJobId).toBeTypeOf('string');

    await app.close();
  });

  it('debe cancelar un job en ejecución y marcarlo como canceled', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';

    app.decorate('config', config);
    app.decorate('useCase', {
      execute: vi.fn().mockImplementation(() => new Promise(() => {
        // job deliberadamente en ejecución para validar cancelación.
      })),
    } as any);

    registerSaldosRoutes(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/saldos/procesar',
      headers: { 'x-api-key': apiKey },
      payload: { fechaDesde: '2024-01-01', batchSize: 1000 },
    });

    expect(created.statusCode).toBe(202);
    const createdBody = created.json();

    const canceled = await app.inject({
      method: 'POST',
      url: `/api/v1/saldos/cancel/${createdBody.jobId}`,
      headers: { 'x-api-key': apiKey },
    });

    expect(canceled.statusCode).toBe(202);
    const canceledBody = canceled.json();
    expect(canceledBody.status).toBe('canceled');

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/saldos/status/${createdBody.jobId}`,
      headers: { 'x-api-key': apiKey },
    });

    expect(status.statusCode).toBe(200);
    const statusBody = status.json();
    expect(statusBody.status).toBe('canceled');

    await app.close();
  });

  it('si se intenta cancelar un job que no está en ejecución, no debe cambiar su estado', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';

    app.decorate('config', config);
    app.decorate('useCase', {
      execute: vi.fn().mockResolvedValue({
        jobId: 'ignored-by-route',
        status: 'completed',
        fechaDesde: '2024-01-01',
        batchSize: 1000,
        periodosProcesados: 1,
        movimientosProcesados: 10,
        movimientosCuentaProcesados: 10,
        tiempoTotalMs: 10,
      }),
    } as any);

    registerSaldosRoutes(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/saldos/procesar',
      headers: { 'x-api-key': apiKey },
      payload: { fechaDesde: '2024-01-01', batchSize: 1000 },
    });

    expect(created.statusCode).toBe(202);
    const createdBody = created.json();
    const jobId = createdBody.jobId as string;

    let currentStatus = 'processing';
    for (let i = 0; i < 10; i++) {
      const statusResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/saldos/status/${jobId}`,
        headers: { 'x-api-key': apiKey },
      });
      currentStatus = statusResponse.json().status;
      if (currentStatus !== 'processing' && currentStatus !== 'pending') {
        break;
      }
    }

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/saldos/cancel/${jobId}`,
      headers: { 'x-api-key': apiKey },
    });

    expect(cancelResponse.statusCode).toBe(409);
    const cancelBody = cancelResponse.json();
    expect(cancelBody.status).toBe(currentStatus);
    expect(cancelBody.error).toContain('No se pudo cancelar');

    const statusAfterCancel = await app.inject({
      method: 'GET',
      url: `/api/v1/saldos/status/${jobId}`,
      headers: { 'x-api-key': apiKey },
    });

    expect(statusAfterCancel.statusCode).toBe(200);
    expect(statusAfterCancel.json().status).toBe(currentStatus);

    await app.close();
  });
});
