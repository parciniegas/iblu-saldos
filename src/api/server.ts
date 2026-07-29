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
import { PeriodoScheduler } from './scheduler/PeriodoScheduler.js';
import { PurgeProcessedEventsScheduler } from './scheduler/PurgeProcessedEventsScheduler.js';
import { ProcessedEventRepository } from '../infrastructure/persistence/ProcessedEventRepository.js';

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

  const saldoRepo = new SaldoContableRepository();
  const saldoPeriodoRepo = new SaldoContablePeriodoRepository();
  const movimientoRepo = new MovimientoContableRepository();
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
  let periodoScheduler: PeriodoScheduler | null = null;
  let purgeScheduler: PurgeProcessedEventsScheduler | null = null;

  if (config.rabbitmq) {
    const processedEventRepo = new ProcessedEventRepository();
    const messageProcessor = new MessageProcessor(
      saldoRepo,
      saldoPeriodoRepo,
      prismaLogger,
      processedEventRepo,
      config.rabbitmq.idempotencyEnabled ?? false,
    );
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

  // Iniciar scheduler de creación de periodos
  try {
    const cronExpr = config.scheduler?.createPeriodoCron ?? '30 0 1 * *';
    periodoScheduler = new PeriodoScheduler();
    periodoScheduler.start(app, cronExpr);
    prismaLogger.info({ cronExpr }, 'Scheduler de periodos iniciado');
  } catch (error) {
    prismaLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'No se pudo iniciar el scheduler de periodos');
  }

  // Iniciar purga de processed_events si idempotencia habilitada y purga habilitada
  try {
    if (config.rabbitmq?.idempotencyEnabled && config.rabbitmq.processedEvents?.enabled) {
      purgeScheduler = new PurgeProcessedEventsScheduler(prismaLogger);
      purgeScheduler.start({
        enabled: true,
        cron: config.rabbitmq.processedEvents.purgeCron ?? '30 3 * * *',
        retentionDays: config.rabbitmq.processedEvents.retentionDays ?? 90,
        chunkSize: config.rabbitmq.processedEvents.chunkSize ?? 5000,
        stuckHours: config.rabbitmq.processedEvents.stuckHours ?? 24,
        optimizeAfterDeletes: config.rabbitmq.processedEvents.optimizeAfterDeletes ?? 100000,
      });
      prismaLogger.info({ cron: config.rabbitmq.processedEvents.purgeCron }, 'Scheduler de purga iniciado');
    } else {
      prismaLogger.info('Scheduler de purga desactivado (idempotencia o purga no habilitadas)');
    }
  } catch (error) {
    prismaLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'No se pudo iniciar el scheduler de purga');
  }

  app.addHook('onClose', async () => {
    await rabbitmqConsumer?.stop();
    periodoScheduler?.stop();
    purgeScheduler?.stop();
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
