import { PrismaClient } from '@prisma/client';
import pino from 'pino';

const prisma = new PrismaClient();

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
