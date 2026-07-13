import { type FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async (_request: any, _reply: any) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/health/detailed', async (_request: any, _reply: any) => {
    const result: { status: string; database?: string; rabbitMq?: string; timestamp: string } = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };

    try {
      const prisma = (app as any).prismaClient;
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
}
