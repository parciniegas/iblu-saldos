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
  rabbitmq?: {
    host: string;
    queueName: string;
    prefetch: number;
    retryAttempts: number;
    retryDelayMs: number;
    idempotencyEnabled?: boolean;
    processedEvents?: {
      enabled?: boolean;
      retentionDays?: number;
      purgeCron?: string;
      chunkSize?: number;
      stuckHours?: number;
      optimizeAfterDeletes?: number;
    };
  };
  scheduler?: {
    createPeriodoCron?: string; // cron expresión para crear periodo automáticamente
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
    rabbitmq: {
      host: 'amqp://localhost',
      queueName: 'saldos_movimientos',
      prefetch: 1,
      retryAttempts: 3,
      retryDelayMs: 5000,
      idempotencyEnabled: false,
      processedEvents: {
        enabled: true,
        retentionDays: 90,
        purgeCron: '30 3 * * *',
        chunkSize: 5000,
        stuckHours: 24,
        optimizeAfterDeletes: 100000,
      },
    },
    scheduler: { createPeriodoCron: '30 0 1 * *' },
  };
}

function applyEnvOverrides(config: AppConfig): AppConfig {
  const connectionString = getEnv('ConnectionStrings__MariaDb', config.connectionString.mariaDb);
  const port = getEnvInt('Server__Port', config.server.port);
  const host = getEnv('Server__Host', config.server.host);

  const rabbitmq = config.rabbitmq
    ? {
        ...config.rabbitmq,
        host: getEnv('RABBITMQ__Host', config.rabbitmq.host),
        queueName: getEnv('RABBITMQ__QueueName', config.rabbitmq.queueName),
        prefetch: getEnvInt('RABBITMQ__Prefetch', config.rabbitmq.prefetch),
        retryAttempts: getEnvInt('RABBITMQ__RetryAttempts', config.rabbitmq.retryAttempts),
        retryDelayMs: getEnvInt('RABBITMQ__RetryDelayMs', config.rabbitmq.retryDelayMs),
        idempotencyEnabled: getEnv('RABBITMQ__IdempotencyEnabled', String(config.rabbitmq.idempotencyEnabled ?? 'false')).toLowerCase() === 'true',
        processedEvents: {
          enabled:
            getEnv('RABBITMQ__ProcessedEvents__Enabled', String(config.rabbitmq.processedEvents?.enabled ?? 'true')).toLowerCase() ===
            'true',
          retentionDays: getEnvInt(
            'RABBITMQ__ProcessedEvents__RetentionDays',
            config.rabbitmq.processedEvents?.retentionDays ?? 90,
          ),
          purgeCron: getEnv(
            'RABBITMQ__ProcessedEvents__PurgeCron',
            config.rabbitmq.processedEvents?.purgeCron ?? '30 3 * * *',
          ),
          chunkSize: getEnvInt('RABBITMQ__ProcessedEvents__ChunkSize', config.rabbitmq.processedEvents?.chunkSize ?? 5000),
          stuckHours: getEnvInt('RABBITMQ__ProcessedEvents__StuckHours', config.rabbitmq.processedEvents?.stuckHours ?? 24),
          optimizeAfterDeletes: getEnvInt(
            'RABBITMQ__ProcessedEvents__OptimizeAfterDeletes',
            config.rabbitmq.processedEvents?.optimizeAfterDeletes ?? 100000,
          ),
        },
      }
    : undefined;

  return {
    ...config,
    connectionString: { mariaDb: connectionString },
    server: { port, host },
    rabbitmq,
    scheduler: {
      createPeriodoCron: getEnv('SCHEDULER__CreatePeriodoCron', config.scheduler?.createPeriodoCron ?? '30 0 1 * *'),
    },
  };
}

export function loadConfig(): AppConfig {
  const fileConfig = loadConfigFile();
  return applyEnvOverrides(fileConfig);
}
