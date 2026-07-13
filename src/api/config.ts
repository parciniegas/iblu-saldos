import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export type AppConfig = {
  connectionString: {
    mariaDb: string;
  };
  apiKeys: {
    allowedKeys: string[];
  };
  procesamientoMovimientos: {
    fechaDesdeDefault: string;
    batchSizeDefault: number;
  };
  logging: {
    level: string;
    filePath: string;
    rollingInterval: string;
  };
  server: {
    port: number;
    host: string;
  };
};

function getEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function getEnvInt(name: string, fallback: number): number {
  const val = process.env[name];
  if (val === undefined) return fallback;
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function loadConfigFile(): AppConfig {
  const configPath = path.resolve(__dirname, '../../config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as AppConfig;
  } catch (error) {
    console.warn(
      `No se pudo cargar config.json (${error instanceof Error ? error.message : String(error)}). Usando configuración por defecto.`,
    );
    return getDefaultConfig();
  }
}

function getDefaultConfig(): AppConfig {
  return {
    connectionString: { mariaDb: 'mysql://root:pass@127.0.0.1:3306/cuentas' },
    apiKeys: { allowedKeys: [] },
    procesamientoMovimientos: { fechaDesdeDefault: '2000-01-01', batchSizeDefault: 1000 },
    logging: { level: 'info', filePath: 'logs/saldos-api-.json', rollingInterval: 'day' },
    server: { port: 3000, host: '0.0.0.0' },
  };
}

function applyEnvOverrides(config: AppConfig): AppConfig {
  const connectionString = getEnv('ConnectionStrings__MariaDb', config.connectionString.mariaDb);
  const port = getEnvInt('Server__Port', config.server.port);
  const host = getEnv('Server__Host', config.server.host);

  return {
    ...config,
    connectionString: { mariaDb: connectionString },
    server: { port, host },
  };
}

export function loadConfig(): AppConfig {
  const fileConfig = loadConfigFile();
  return applyEnvOverrides(fileConfig);
}
