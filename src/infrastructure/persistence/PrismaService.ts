import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

type MinimalConfig = {
  connectionString?: {
    mariaDb?: string;
  };
};

function readConnectionStringFromConfigFile(): string | undefined {
  const configPath = path.resolve(__dirname, '../../../config.json');

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as MinimalConfig;
    return parsed.connectionString?.mariaDb;
  } catch {
    return undefined;
  }
}

function resolveDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL
    ?? process.env.ConnectionStrings__MariaDb
    ?? readConnectionStringFromConfigFile();
}

const databaseUrl = resolveDatabaseUrl();

if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
}

const prisma = new PrismaClient(
  databaseUrl
    ? {
        datasources: {
          db: {
            url: databaseUrl,
          },
        },
      }
    : undefined,
);

let logger: pino.Logger | null = null;

export function setPrismaLogger(log: pino.Logger): void {
  logger = log;
}

export async function connectPrisma(): Promise<void> {
  try {
    await prisma.$connect();
    logger?.info('Prisma conectado a la base de datos');
  } catch (error) {
    logger?.error({ error: error instanceof Error ? error.message : String(error) }, 'Error conectando a la base de datos');
    throw error;
  }
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma, logger };
