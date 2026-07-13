import { type FastifyInstance } from 'fastify';

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
      description: 'Incluye estado de base de datos.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            database: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    const result: { status: string; database?: string; timestamp: string } = {
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

    return result;
  });

  app.get('/health/metrics', {
    schema: {
      tags: ['Health'],
      summary: 'Métricas operativas',
      description: 'Retorna métricas operativas básicas del API.',
      response: {
        200: {
          type: 'object',
          properties: {
            timestamp: { type: 'string' },
            database: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    let database = 'disconnected';

    try {
      const prisma = app.prismaClient;
      if (prisma) {
        await prisma.$queryRaw`SELECT 1`;
        database = 'connected';
      } else {
        database = 'not configured';
      }
    } catch {
      database = 'disconnected';
    }

    return {
      timestamp: new Date().toISOString(),
      database,
    };
  });
}
