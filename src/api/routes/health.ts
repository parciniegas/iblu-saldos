import { type FastifyInstance } from 'fastify';
import type { RabbitMqRuntimeStats } from '../../infrastructure/messaging/RabbitMqService.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/health/detailed', async () => {
    const result: { status: string; database?: string; rabbitMq?: string; rabbitMqStats?: RabbitMqRuntimeStats; timestamp: string } = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };

    try {
      const prisma = app.prismaClient;
      if (prisma) {
        await prisma.$queryRaw`SELECT 1`;
        result.database = 'connected';
      } else {
        result.database = 'not configured';
      }
    } catch {
      result.database = 'disconnected';
    }

    result.rabbitMq = app.rabbitMqService ? 'connected' : 'disconnected';
    if (app.rabbitMqService) {
      result.rabbitMqStats = app.rabbitMqService.getStats();
    }

    return result;
  });

  app.get('/health/metrics', async () => {
    return {
      timestamp: new Date().toISOString(),
      rabbitMq: app.rabbitMqService?.getStats() ?? null,
    };
  });
}
