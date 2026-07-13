import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'ConnectionStrings__MariaDb',
  'Server__Port',
  'Server__Host',
] as const;

const previousEnv = new Map<string, string | undefined>();

async function importConfigModule() {
  vi.resetModules();
  return import('../../src/api/config.js');
}

describe('loadConfig', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const originalValue = previousEnv.get(key);
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }

    previousEnv.clear();
    vi.restoreAllMocks();
  });

  it('aplica overrides de entorno con tipos numéricos para puertos', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        connectionString: { mariaDb: 'mysql://db-user:db-pass@localhost:3306/db' },
        apiKeys: { allowedKeys: ['api-key-1'] },
        procesamientoMovimientos: { fechaDesdeDefault: '2020-01-01', batchSizeDefault: 2000 },
        logging: { level: 'debug', filePath: 'logs/saldos-api-.json', rollingInterval: 'day' },
        server: { port: 3000, host: '127.0.0.1' },
      }),
    );

    process.env.Server__Port = '3010';

    const { loadConfig } = await importConfigModule();
    const config = loadConfig();

    expect(config.server.port).toBe(3010);
  });

  it('usa configuración por defecto y advierte cuando config.json es inválido', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{invalid-json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Silence expected warning in tests.
    });

    const { loadConfig } = await importConfigModule();
    const config = loadConfig();

    expect(config.connectionString.mariaDb).toBe('mysql://root:pass@127.0.0.1:3306/cuentas');
    expect(config.logging.filePath).toBe('logs/saldos-api-.json');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
