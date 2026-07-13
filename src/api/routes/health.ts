import { type FastifyInstance } from 'fastify';
import type { RabbitMqRuntimeStats } from '../../infrastructure/messaging/RabbitMqService.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Health básico',
      description: 'Verifica disponibilidad del servicio API.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/health/detailed', {
    schema: {
      tags: ['Health'],
      summary: 'Health detallado',
      description: 'Incluye estado de base de datos y telemetría básica de RabbitMQ.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            database: { type: 'string' },
            rabbitMq: { type: 'string' },
            rabbitMqStats: { type: 'object', additionalProperties: true },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
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

  app.get('/health/metrics', {
    schema: {
      tags: ['Health'],
      summary: 'Métricas operativas',
      description: 'Retorna métricas agregadas de RabbitMQ observadas por el API.',
      response: {
        200: {
          type: 'object',
          properties: {
            timestamp: { type: 'string' },
            rabbitMq: { type: ['object', 'null'], additionalProperties: true },
          },
        },
      },
    },
  }, async () => {
    return {
      timestamp: new Date().toISOString(),
      rabbitMq: app.rabbitMqService?.getStats() ?? null,
    };
  });
}
