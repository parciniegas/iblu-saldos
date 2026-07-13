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
  rabbitMq: {
    hostName: string;
    port: number;
    userName: string;
    password: string;
    virtualHost: string;
    queueName: string;
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
    rabbitMq: { hostName: 'localhost', port: 5672, userName: 'admin', password: 'P2ssw0rd', virtualHost: '/', queueName: 'saldos' },
    logging: { level: 'info', filePath: 'logs/saldos-worker-.json', rollingInterval: 'day' },
    server: { port: 3000, host: '0.0.0.0' },
  };
}

function applyEnvOverrides(config: AppConfig): AppConfig {
  const connectionString = getEnv('ConnectionStrings__MariaDb', config.connectionString.mariaDb);
  const port = getEnvInt('Server__Port', config.server.port);
  const host = getEnv('Server__Host', config.server.host);
  const rabbitHost = getEnv('RabbitMq__HostName', config.rabbitMq.hostName);
  const rabbitPort = getEnvInt('RabbitMq__Port', config.rabbitMq.port);
  const rabbitUser = getEnv('RabbitMq__UserName', config.rabbitMq.userName);
  const rabbitPass = getEnv('RabbitMq__Password', config.rabbitMq.password);
  const rabbitVHost = getEnv('RabbitMq__VirtualHost', config.rabbitMq.virtualHost);
  const rabbitQueue = getEnv('RabbitMq__QueueName', config.rabbitMq.queueName);

  return {
    ...config,
    connectionString: { mariaDb: connectionString },
    server: { port, host },
    rabbitMq: {
      ...config.rabbitMq,
      hostName: rabbitHost,
      port: rabbitPort,
      userName: rabbitUser,
      password: rabbitPass,
      virtualHost: rabbitVHost,
      queueName: rabbitQueue,
    },
  };
}

export function loadConfig(): AppConfig {
  const fileConfig = loadConfigFile();
  return applyEnvOverrides(fileConfig);
}
