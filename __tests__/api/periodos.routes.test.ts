import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerPeriodosRoutes } from '../../src/api/routes/periodos.js';
import { loadConfig } from '../../src/api/config.js';

describe('API periodos routes', () => {
  let previousStorePath: string | undefined;
  let isolatedStorePath: string;

  beforeEach(() => {
    previousStorePath = process.env.SALDOS_JOB_STORE_PATH;
    isolatedStorePath = path.join(os.tmpdir(), `saldos-jobs-periodos-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    process.env.SALDOS_JOB_STORE_PATH = isolatedStorePath;
  });

  afterEach(() => {
    if (previousStorePath === undefined) delete process.env.SALDOS_JOB_STORE_PATH;
    else process.env.SALDOS_JOB_STORE_PATH = previousStorePath;
    if (fs.existsSync(isolatedStorePath)) fs.unlinkSync(isolatedStorePath);
  });

  it('debe crear job y bloquear solicitudes concurrentes', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';

    app.decorate('config', config);
    app.decorate('saldoPeriodoRepo', {
      existsByNombre: vi.fn().mockResolvedValue(false),
      getUltimoPeriodo: vi.fn().mockResolvedValue({ id: 1, nombre: '202412', cierre: false, cierreAnio: false }),
      create: vi.fn().mockResolvedValue({ id: 2 }),
    } as any);
    app.decorate('saldoRepo', { copyFromPeriodo: vi.fn().mockResolvedValue(5) } as any);

    // Inyectar un use case que no resuelve para simular ejecución en curso
    app.decorate('createPeriodoUseCase', {
      execute: vi.fn().mockImplementation(() => new Promise(() => {})),
    } as any);
    registerPeriodosRoutes(app);

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/periodos',
      headers: { 'x-api-key': apiKey },
      payload: { fecha: '2025-01-15' },
    });

    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/periodos',
      headers: { 'x-api-key': apiKey },
      payload: { fecha: '2025-01-20' },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain('job de creación');

    await app.close();
  });

  it('debe retornar 409 si el periodo ya existe', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';
    app.decorate('config', config);
    app.decorate('saldoPeriodoRepo', {
      existsByNombre: vi.fn().mockResolvedValue(true),
      getUltimoPeriodo: vi.fn(),
      create: vi.fn(),
    } as any);
    app.decorate('saldoRepo', { copyFromPeriodo: vi.fn() } as any);

    registerPeriodosRoutes(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/periodos',
      headers: { 'x-api-key': apiKey },
      payload: { fecha: '2025-01-01' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PERIODO_YA_EXISTE');
    await app.close();
  });

  it('debe retornar 400 si no hay periodo anterior', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';
    app.decorate('config', config);
    app.decorate('saldoPeriodoRepo', {
      existsByNombre: vi.fn().mockResolvedValue(false),
      getUltimoPeriodo: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    } as any);
    app.decorate('saldoRepo', { copyFromPeriodo: vi.fn() } as any);

    registerPeriodosRoutes(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/periodos',
      headers: { 'x-api-key': apiKey },
      payload: { fecha: '2025-01-01' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SIN_PERIODO_ANTERIOR');
    await app.close();
  });

  it('debe retornar 400 si no es el inmediatamente anterior', async () => {
    const app = Fastify();
    const config = loadConfig();
    const apiKey = config.apiKeys.allowedKeys[0] ?? 'test-api-key';
    app.decorate('config', config);
    app.decorate('saldoPeriodoRepo', {
      existsByNombre: vi.fn().mockResolvedValue(false),
      getUltimoPeriodo: vi.fn().mockResolvedValue({ id: 1, nombre: '202411', cierre: false, cierreAnio: false }),
      create: vi.fn(),
    } as any);
    app.decorate('saldoRepo', { copyFromPeriodo: vi.fn() } as any);

    registerPeriodosRoutes(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/periodos',
      headers: { 'x-api-key': apiKey },
      payload: { fecha: '2025-01-01' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('GAP_NO_PERMITIDO');
    await app.close();
  });
});
