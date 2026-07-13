import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { registerAuthPlugin } from '../plugins/auth.js';
import type { JobStatus } from '../services/JobService.js';
import { createJobService } from '../services/createJobService.js';

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
  const jobService = createJobService();
  const cleanupTimer = setInterval(() => {
    jobService.cleanup();
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();

  const MIN_BATCH_SIZE = 1000;
  const MAX_BATCH_SIZE = 10000;
  const allowedStatuses = new Set<JobStatus>(['pending', 'processing', 'completed', 'failed', 'canceled']);

  const parseJobStatus = (status?: string): JobStatus | undefined => {
    if (!status) return undefined;
    return allowedStatuses.has(status as JobStatus) ? (status as JobStatus) : undefined;
  };

  const updateWhileProcessing = (
    jobId: string,
    updates: Parameters<typeof jobService.updateJob>[1],
    context: string,
    allowedCurrentStatuses: JobStatus[] = ['processing'],
  ): boolean => {
    const current = jobService.getJob(jobId);

    if (!current) {
      app.log.warn({ jobId, context }, 'No se actualiza job porque no existe');
      return false;
    }

    if (!allowedCurrentStatuses.includes(current.status)) {
      app.log.warn({ jobId, context, currentStatus: current.status, allowedCurrentStatuses }, 'No se actualiza job porque no está en un estado permitido');
      return false;
    }

    jobService.updateJob(jobId, updates);
    return true;
  };

  // GET /api/v1/saldos/jobs
  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/v1/saldos/jobs', {
    schema: {
      tags: ['Saldos'],
      security: [{ apiKey: [] }],
      summary: 'Listar jobs',
      description: 'Lista jobs de procesamiento con filtros opcionales por estado y límite.',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed', 'canceled'] },
          limit: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
    },
  }, async (request) => {
    const { status, limit } = request.query;

    const jobs = jobService.listJobs({
      status: parseJobStatus(status),
      limit: limit ? Number.parseInt(limit, 10) : 50,
    });

    return jobs;
  });

  // GET /api/v1/saldos/jobs/metrics
  app.get('/api/v1/saldos/jobs/metrics', {
    schema: {
      tags: ['Saldos'],
      security: [{ apiKey: [] }],
      summary: 'Métricas de jobs',
      description: 'Retorna conteo total de jobs por estado.',
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            pending: { type: 'number' },
            processing: { type: 'number' },
            completed: { type: 'number' },
            failed: { type: 'number' },
            canceled: { type: 'number' },
          },
        },
      },
    },
  }, async () => {
    const all = jobService.listJobs({ limit: 10000 });
    const metrics = {
      total: all.length,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    };

    for (const job of all) {
      metrics[job.status] += 1;
    }

    return metrics;
  });

  // GET /api/v1/saldos/status/:jobId
  app.get<{ Params: { jobId: string } }>('/api/v1/saldos/status/:jobId', {
    schema: {
      tags: ['Saldos'],
      security: [{ apiKey: [] }],
      summary: 'Consultar estado de job',
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            jobId: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { jobId } = request.params;

    const job = jobService.getJob(jobId);

    if (!job) {
      return reply.status(404).send({ error: 'Job no encontrado', jobId });
    }

    return job;
  });

  // POST /api/v1/saldos/preview
  app.post<{ Body: { fechaDesde: string; batchSize?: number } }>('/api/v1/saldos/preview', {
    schema: {
      tags: ['Saldos'],
      security: [{ apiKey: [] }],
      summary: 'Previsualizar procesamiento',
      body: {
        type: 'object',
        required: ['fechaDesde'],
        properties: {
          fechaDesde: { type: 'string', format: 'date' },
          batchSize: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { type: 'object', additionalProperties: true },
        409: { type: 'object', additionalProperties: true },
        503: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    try {
      const parsed = previewSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validación fallida',
          details: parsed.error.errors,
        });
      }

      const { fechaDesde, batchSize } = parsed.data;
      const config = app.config;
      const effectiveBatchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, batchSize ?? config?.procesamientoMovimientos?.batchSizeDefault ?? 1000));

      const movimientoRepo = app.movimientoRepo;

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
  app.post<{ Body: { fechaDesde: string; batchSize?: number } }>('/api/v1/saldos/procesar', {
    schema: {
      tags: ['Saldos'],
      security: [{ apiKey: [] }],
      summary: 'Iniciar procesamiento en background',
      body: {
        type: 'object',
        required: ['fechaDesde'],
        properties: {
          fechaDesde: { type: 'string', format: 'date' },
          batchSize: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            status: { type: 'string' },
            fechaDesde: { type: 'string' },
            batchSize: { type: 'number' },
          },
        },
        400: { type: 'object', additionalProperties: true },
        503: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    try {
      const parsed = procesarSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validación fallida',
          details: parsed.error.errors,
        });
      }

      const { fechaDesde, batchSize } = parsed.data;
      const config = app.config;
      const effectiveBatchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, batchSize ?? config?.procesamientoMovimientos?.batchSizeDefault ?? 1000));

      const runningJob = jobService.listJobs({ status: 'processing', limit: 1 }).at(0);
      if (runningJob) {
        return reply.status(409).send({
          error: 'Ya existe un job en ejecución',
          runningJobId: runningJob.jobId,
        });
      }

      const jobId = uuidv4();
      jobService.createJob(jobId, fechaDesde, effectiveBatchSize);

      const useCase = app.useCase;

      if (!useCase) {
        jobService.updateJob(jobId, { status: 'failed', error: 'Use case no disponible' });
        return reply.status(503).send({ error: 'Use case no disponible' });
      }

      // Start processing in background
      (async () => {
        try {
          updateWhileProcessing(jobId, { status: 'processing' }, 'inicio procesamiento', ['pending', 'processing']);

          const result = await useCase.execute(fechaDesde, effectiveBatchSize, jobId, {
            progressIntervalMs: 2000,
            shouldCancel: () => {
              const current = jobService.getJob(jobId);
              return current?.status === 'canceled';
            },
            onProgress: (progress) => {
              updateWhileProcessing(jobId, {
                status: progress.status,
                periodosProcesados: progress.periodosProcesados,
                movimientosProcesados: progress.movimientosProcesados,
                movimientosCuentaProcesados: progress.movimientosCuentaProcesados,
                tiempoTotalMs: progress.tiempoTotalMs,
                eta: progress.eta,
              }, 'progreso');
            },
          });

          if (result.status === 'completed') {
            updateWhileProcessing(jobId, {
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
            }, 'resultado completed');
          } else if (result.status === 'canceled') {
            updateWhileProcessing(jobId, {
              status: 'canceled',
              periodosProcesados: result.periodosProcesados,
              movimientosProcesados: result.movimientosProcesados,
              movimientosCuentaProcesados: result.movimientosCuentaProcesados,
              tiempoTotalMs: result.tiempoTotalMs,
              eta: result.eta,
              error: result.error,
            }, 'resultado canceled');
          } else {
            updateWhileProcessing(jobId, {
              status: 'failed',
              error: result.error,
            }, 'resultado failed');
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          updateWhileProcessing(jobId, { status: 'failed', error: errorMessage }, 'error en ejecución');
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

  // POST /api/v1/saldos/cancel/:jobId
  app.post<{ Params: { jobId: string } }>('/api/v1/saldos/cancel/:jobId', {
    schema: {
      tags: ['Saldos'],
      security: [{ apiKey: [] }],
      summary: 'Cancelar un job en ejecución',
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'string' },
        },
      },
      response: {
        202: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
        409: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { jobId } = request.params;
    const job = jobService.getJob(jobId);

    if (!job) {
      return reply.status(404).send({ error: 'Job no encontrado', jobId });
    }

    if (job.status === 'processing') {
      const canceled = jobService.updateJob(jobId, {
        status: 'canceled',
        error: 'Cancelado por solicitud del usuario',
      });

      return reply.status(202).send({
        jobId,
        status: canceled?.status ?? 'canceled',
      });
    }

    const error = `No se pudo cancelar: el job no está en ejecución (estado actual: ${job.status}).`;
    app.log.warn({ jobId, currentStatus: job.status }, error);

    return reply.status(409).send({
      jobId,
      status: job.status,
      error,
    });
  });

}
