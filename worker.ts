import pino from 'pino';
import { loadConfig, type AppConfig } from './src/api/config.js';
import { connectPrisma, setPrismaLogger, disconnectPrisma } from './src/infrastructure/persistence/PrismaService.js';
import { MovimientoContableRepository } from './src/infrastructure/persistence/MovimientoContableRepository.js';
import { SaldoContableRepository } from './src/infrastructure/persistence/SaldoContableRepository.js';
import { ProcesarSaldosContablesUseCase } from './src/application/useCases/ProcesarSaldosContablesUseCase.js';
import { RabbitMqServiceImpl, type RabbitMqSettings } from './src/infrastructure/messaging/RabbitMqService.js';
import { saldosQueueMessageSchema, toSaldosQueueMessage } from './src/application/contracts/SaldosQueueMessage.js';
import { v4 as uuidv4 } from 'uuid';

const config: AppConfig = loadConfig();

const logger = pino({
  name: 'saldos-worker',
  transport: config.logging.filePath
    ? {
        target: 'pino-roll',
        options: {
          file: config.logging.filePath,
          size: config.logging.rollingInterval === 'day' ? '1d' : '1M',
          interval: config.logging.rollingInterval,
        },
      }
    : undefined,
});

setPrismaLogger(logger);

async function startWorker(): Promise<void> {
  try {
    await connectPrisma();
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Base de datos no disponible, el worker continuará pero no podrá procesar');
  }

  const movimientoRepo = new MovimientoContableRepository();
  const saldoRepo = new SaldoContableRepository();
  const useCase = new ProcesarSaldosContablesUseCase(movimientoRepo, saldoRepo, logger);

  const rabbitSettings: RabbitMqSettings = config.rabbitMq;
  const rabbitMqService = new RabbitMqServiceImpl(rabbitSettings);
  rabbitMqService.setLogger(logger);

  await rabbitMqService.connect();

  const queueName = config.rabbitMq.queueName;
  let invalidMessagesCount = 0;
  let processedMessagesCount = 0;

  await rabbitMqService.consume(queueName, async (message: unknown) => {
    const parsedMessage = saldosQueueMessageSchema.safeParse(message);
    if (!parsedMessage.success) {
      invalidMessagesCount += 1;
      logger.error({
        errors: parsedMessage.error.issues,
        rawMessage: message,
        invalidMessagesCount,
        processedMessagesCount,
      }, '[WORKER] Mensaje inválido, descartado');
      return;
    }

    const normalizedMessage = toSaldosQueueMessage(parsedMessage.data);
    processedMessagesCount += 1;
    const jobId = uuidv4();
    const fechaDesde = normalizedMessage.fechaDesde;
    const batchSize = normalizedMessage.batchSize || config.procesamientoMovimientos.batchSizeDefault;

    logger.info({ jobId, fechaDesde, batchSize }, '[WORKER] Recibido mensaje de procesamiento');

    try {
      const result = await useCase.execute(fechaDesde, batchSize, jobId);

      if (result.status === 'completed') {
        logger.info({ jobId, periodosProcesados: result.periodosProcesados, tiempoTotalMs: result.tiempoTotalMs }, '[WORKER] Procesamiento completado');
      } else {
        logger.error({ jobId, error: result.error }, '[WORKER] Procesamiento fallido');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ jobId, error: errorMessage }, '[WORKER] Excepción no manejada');
    }
  });

  logger.info({ queueName }, 'Worker escuchando mensajes');

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM recibido, cerrando worker...');
    await rabbitMqService.close();
    await disconnectPrisma();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT recibido, cerrando worker...');
    await rabbitMqService.close();
    await disconnectPrisma();
    process.exit(0);
  });
}

try {
  await startWorker();
} catch (error) {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error iniciando worker');
  process.exit(1);
}
