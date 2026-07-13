import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { registerAuthPlugin } from '../plugins/auth.js';
import { InMemoryJobService } from '../services/InMemoryJobService.js';

const jobService = new InMemoryJobService();

const previewSchema = z.object({
  fechaDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido. Use yyyy-MM-dd'),
  batchSize: z.number().int().positive().optional(),
});

const procesarSchema = z.object({
  fechaDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido. Use yyyy-MM-dd'),
  batchSize: z.number().int().positive().optional(),
});

export function registerSaldosRoutes(app: FastifyInstance): void {
  registerAuthPlugin(app);

  const MIN_BATCH_SIZE = 1000;
  const MAX_BATCH_SIZE = 10000;

  // GET /api/v1/saldos/jobs
  app.get('/api/v1/saldos/jobs', async (_request: any, _reply: any) => {
    const { status, limit } = _request.query as { status?: string; limit?: string };

    const jobs = jobService.listJobs({
      status: status as any,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    return jobs;
  });

  // GET /api/v1/saldos/status/:jobId
  app.get<{ Params: { jobId: string } }>('/api/v1/saldos/status/:jobId', async (request, reply) => {
    const { jobId } = request.params;

    const job = jobService.getJob(jobId);

    if (!job) {
      return reply.status(404).send({ error: 'Job no encontrado', jobId });
    }

    return job;
  });

  // POST /api/v1/saldos/preview
  app.post<{ Body: { fechaDesde: string; batchSize?: number } }>('/api/v1/saldos/preview', async (request, reply) => {
    try {
      const parsed = previewSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validación fallida',
          details: parsed.error.errors,
        });
      }

      const { fechaDesde, batchSize } = parsed.data;
      const config = (app as any).config;
      const effectiveBatchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, batchSize ?? config?.procesamientoMovimientos?.batchSizeDefault ?? 1000));

      const movimientoRepo = (app as any).movimientoRepo;

      if (!movimientoRepo) {
        return reply.status(503).send({ error: 'Base de datos no disponible' });
      }

      const fechaDesdeDate = new Date(fechaDesde + 'T00:00:00');
      const periodos = await movimientoRepo.getPeriodosDesdeFecha(fechaDesdeDate);

      return {
        fechaDesde,
        batchSize: effectiveBatchSize,
        periodosCount: periodos.length,
        periodos,
        mensaje: `Se procesarían ${periodos.length} períodos con batch size ${effectiveBatchSize}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      app.log.error({ error: errorMessage }, 'Error en preview');
      return reply.status(500).send({ error: 'Error interno', detail: errorMessage });
    }
  });

  // POST /api/v1/saldos/procesar
  app.post<{ Body: { fechaDesde: string; batchSize?: number } }>('/api/v1/saldos/procesar', async (request, reply) => {
    try {
      const parsed = procesarSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validación fallida',
          details: parsed.error.errors,
        });
      }

      const { fechaDesde, batchSize } = parsed.data;
      const config = (app as any).config;
      const effectiveBatchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, batchSize ?? config?.procesamientoMovimientos?.batchSizeDefault ?? 1000));

      const jobId = uuidv4();
      jobService.createJob(jobId, fechaDesde, effectiveBatchSize);

      const useCase = (app as any).useCase;

      if (!useCase) {
        jobService.updateJob(jobId, { status: 'failed', error: 'Use case no disponible' });
        return reply.status(503).send({ error: 'Use case no disponible' });
      }

      // Start processing in background
      (async () => {
        try {
          jobService.updateJob(jobId, { status: 'processing' });

          const result = await useCase.execute(fechaDesde, effectiveBatchSize, jobId);

          if (result.status === 'completed') {
            jobService.updateJob(jobId, {
              status: 'completed',
              periodosProcesados: result.periodosProcesados,
              movimientosProcesados: result.movimientosProcesados,
              movimientosCuentaProcesados: result.movimientosCuentaProcesados,
              tiempoTotalMs: result.tiempoTotalMs,
              eta: result.eta,
              resultado: {
                periodosProcesados: result.periodosProcesados,
                movimientosProcesados: result.movimientosProcesados,
                movimientosCuentaProcesados: result.movimientosCuentaProcesados,
                tiempoTotalMs: result.tiempoTotalMs,
                eta: result.eta,
              },
            });
          } else {
            jobService.updateJob(jobId, {
              status: 'failed',
              error: result.error,
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          jobService.updateJob(jobId, { status: 'failed', error: errorMessage });
        }
      })();

      const job = jobService.getJob(jobId)!;

      return reply.code(202).send({
        jobId,
        status: job.status,
        fechaDesde,
        batchSize: effectiveBatchSize,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      app.log.error({ error: errorMessage }, 'Error en procesar');
      return reply.status(500).send({ error: 'Error interno', detail: errorMessage });
    }
  });

  // POST /api/v1/saldos/queue
  app.post<{ Body: { fechaDesde: string; batchSize: number } }>('/api/v1/saldos/queue', async (request, reply) => {
    try {
      const parsed = procesarSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validación fallida',
          details: parsed.error.errors,
        });
      }

      const { fechaDesde, batchSize } = parsed.data;
      const config = (app as any).config;
      const effectiveBatchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, batchSize ?? config?.procesamientoMovimientos?.batchSizeDefault ?? 1000));

      const rabbitMqService = (app as any).rabbitMqService;

      if (!rabbitMqService) {
        return reply.status(503).send({ error: 'RabbitMQ no disponible' });
      }

      const queueName = config.rabbitMq.queueName;

      await rabbitMqService.publish(queueName, { fechaDesde, batchSize: effectiveBatchSize });

      return reply.send({
        published: true,
        queueName,
        fechaDesde,
        batchSize: effectiveBatchSize,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      app.log.error({ error: errorMessage }, 'Error publicando a RabbitMQ');
      return reply.status(500).send({ error: 'Error publicando mensaje', detail: errorMessage });
    }
  });
}
