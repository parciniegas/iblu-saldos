import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import pino from 'pino';
import { loadConfig } from './config.js';
import { connectPrisma, prisma, setPrismaLogger, disconnectPrisma } from '../infrastructure/persistence/PrismaService.js';
import { MovimientoContableRepository } from '../infrastructure/persistence/MovimientoContableRepository.js';
import { SaldoContableRepository } from '../infrastructure/persistence/SaldoContableRepository.js';
import { SaldoContablePeriodoRepository } from '../infrastructure/persistence/SaldoContablePeriodoRepository.js';
import { ProcesarSaldosContablesUseCase } from '../application/useCases/ProcesarSaldosContablesUseCase.js';
import { registerSaldosRoutes } from './routes/saldos.js';
import { registerPeriodosRoutes } from './routes/periodos.js';
import { registerHealthRoutes } from './routes/health.js';
import { MessageProcessor } from './rabbitmq/MessageProcessor.js';
import { RabbitMQConsumer } from './rabbitmq/RabbitMQConsumer.js';
import { createJobService } from './services/createJobService.js';

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
        { name: 'Periodos', description: 'Administración de periodos contables' },
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
      servers: [{ url: '/', description: 'Current origin' }],
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
  const saldoPeriodoRepo = new SaldoContablePeriodoRepository();
  const useCase = new ProcesarSaldosContablesUseCase(movimientoRepo, saldoRepo, saldoPeriodoRepo, prismaLogger);

  app.decorate('movimientoRepo', movimientoRepo);
  app.decorate('saldoRepo', saldoRepo);
  app.decorate('saldoPeriodoRepo', saldoPeriodoRepo);
  app.decorate('useCase', useCase);
  app.decorate('config', config);
  app.decorate('logger', prismaLogger);
  app.decorate('prismaClient', prisma);
  app.decorate('jobService', createJobService());

  registerSaldosRoutes(app);
  registerPeriodosRoutes(app);
  registerHealthRoutes(app);

  const port = config.server.port;
  const host = config.server.host;

  let rabbitmqConsumer: RabbitMQConsumer | null = null;

  if (config.rabbitmq) {
    const messageProcessor = new MessageProcessor(movimientoRepo, saldoRepo, saldoPeriodoRepo, prismaLogger);
    rabbitmqConsumer = new RabbitMQConsumer(config.rabbitmq, messageProcessor, prismaLogger);

    try {
      await rabbitmqConsumer.start();
    } catch (error) {
      prismaLogger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'RabbitMQ no disponible, continuando sin consumidor',
      );
    }
  }

  app.addHook('onClose', async () => {
    await rabbitmqConsumer?.stop();
    await disconnectPrisma();
  });

  try {
    await app.listen({ port, host });
    prismaLogger.info({ port, host }, 'API escuchando');
  } catch (error) {
    prismaLogger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error iniciando API');
    await rabbitmqConsumer?.stop();
    await disconnectPrisma();
    throw error;
  }

  return app;
}

export { start, config, prismaLogger };
