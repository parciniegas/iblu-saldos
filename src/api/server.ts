import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import pino from 'pino';
import { loadConfig } from './config.js';
import { connectPrisma, prisma, setPrismaLogger } from '../infrastructure/persistence/PrismaService.js';
import { MovimientoContableRepository } from '../infrastructure/persistence/MovimientoContableRepository.js';
import { SaldoContableRepository } from '../infrastructure/persistence/SaldoContableRepository.js';
import { RabbitMqServiceImpl, type RabbitMqSettings } from '../infrastructure/messaging/RabbitMqService.js';
import { ProcesarSaldosContablesUseCase } from '../application/useCases/ProcesarSaldosContablesUseCase.js';
import { registerSaldosRoutes } from './routes/saldos.js';
import { registerHealthRoutes } from './routes/health.js';

const config = loadConfig();

function buildPinoOptions(): pino.LoggerOptions {
  const transport = config.logging.filePath
    ? {
        target: 'pino-roll',
        options: {
          file: config.logging.filePath,
          size: config.logging.rollingInterval === 'day' ? '1d' : '1M',
          interval: config.logging.rollingInterval,
        },
      }
    : undefined;

  return {
    name: 'saldos-api',
    transport,
  };
}

const prismaLogger = pino({ name: 'saldos-api' });
setPrismaLogger(prismaLogger);

async function start(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildPinoOptions(),
  });

  await app.register(fastifyCors, { origin: true });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Saldos API',
        description: 'API para procesamiento de saldos contables',
        version: '1.0.0',
      },
      tags: [
        { name: 'Health', description: 'Estado operativo del servicio' },
        { name: 'Saldos', description: 'Procesamiento y administración de saldos contables' },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'x-api-key',
            in: 'header',
          },
        },
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local' }],
      externalDocs: {
        url: 'https://github.com/your-org/saldos-node',
        description: 'Documentación',
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/documentation',
    staticCSP: true,
  });

  try {
    await connectPrisma();
  } catch (error) {
    prismaLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Base de datos no disponible, continuando sin ella');
  }

  const movimientoRepo = new MovimientoContableRepository();
  const saldoRepo = new SaldoContableRepository();
  const useCase = new ProcesarSaldosContablesUseCase(movimientoRepo, saldoRepo, prismaLogger);
  const rabbitSettings: RabbitMqSettings = config.rabbitMq;
  const rabbitMqService = new RabbitMqServiceImpl(rabbitSettings);
  rabbitMqService.setLogger(prismaLogger);

  try {
    await rabbitMqService.connect();
    app.decorate('rabbitMqService', rabbitMqService);
  } catch (error) {
    prismaLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'RabbitMQ no disponible, ruta /queue degradada');
  }

  app.decorate('movimientoRepo', movimientoRepo);
  app.decorate('saldoRepo', saldoRepo);
  app.decorate('useCase', useCase);
  app.decorate('config', config);
  app.decorate('logger', prismaLogger);
  app.decorate('prismaClient', prisma);

  app.addHook('onClose', async () => {
    await rabbitMqService.close();
  });

  registerSaldosRoutes(app);
  registerHealthRoutes(app);

  const port = config.server.port;
  const host = config.server.host;

  try {
    await app.listen({ port, host });
    prismaLogger.info({ port, host }, 'API escuchando');
  } catch (error) {
    prismaLogger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error iniciando API');
    throw error;
  }

  return app;
}

export { start, config, prismaLogger };
