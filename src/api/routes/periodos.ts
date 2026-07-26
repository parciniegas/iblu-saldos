import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { registerAuthPlugin } from '../plugins/auth.js';
import { createJobService } from '../services/createJobService.js';
import { CreatePeriodoUseCase, PeriodoNoInmediatoAnteriorError, PeriodoSinAnteriorError, PeriodoYaExisteError } from '../../application/useCases/CreatePeriodoUseCase.js';

const schema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido. Use yyyy-MM-dd'),
});

const JOB_PREFIX = 'crear-periodo:';

export function registerPeriodosRoutes(app: FastifyInstance): void {
  registerAuthPlugin(app);
  let jobService = (app as any).jobService;
  if (!jobService) {
    jobService = createJobService();
    (app as any).jobService = jobService;
    const cleanupTimer = setInterval(() => {
      jobService.cleanup();
    }, 60 * 60 * 1000);
    cleanupTimer.unref?.();
    (app as any).jobServiceCleanupTimer = cleanupTimer;
  }

  app.post<{ Body: { fecha: string } }>('/api/v1/periodos', {
    schema: {
      tags: ['Periodos'],
      security: [{ apiKey: [] }],
      summary: 'Crear un nuevo periodo contable',
      body: {
        type: 'object',
        required: ['fecha'],
        properties: { fecha: { type: 'string', format: 'date' } },
      },
      response: {
        202: { type: 'object', additionalProperties: true },
        400: { type: 'object', additionalProperties: true },
        409: { type: 'object', additionalProperties: true },
        503: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    // Validación
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validación fallida', details: parsed.error.errors });
    }

    // Concurrencia: bloquear si hay job crear-periodo pendiente/procesando
    const conflict = jobService.listJobs({ limit: 50 })
      .find((j: any) => (j.status === 'pending' || j.status === 'processing') && j.jobId.startsWith(JOB_PREFIX));
    if (conflict) {
      return reply.status(409).send({ error: 'Ya existe un job de creación de periodo en ejecución', runningJobId: conflict.jobId });
    }

    const fechaISO = parsed.data.fecha;
    const fecha = new Date(fechaISO + 'T00:00:00.000Z');

    if (!app.saldoPeriodoRepo || !app.saldoRepo) {
      return reply.status(503).send({ error: 'Repos no disponibles' });
    }

    // Pre-validación de reglas de negocio (sin gaps y no duplicado)
    const year = fecha.getUTCFullYear();
    const month0 = fecha.getUTCMonth();
    const mm = String(month0 + 1).padStart(2, '0');
    const nombre = `${year}${mm}`;

    try {
      const exists = await app.saldoPeriodoRepo.existsByNombre(nombre);
      if (exists) {
        return reply.status(409).send({ code: 'PERIODO_YA_EXISTE', message: `El periodo ${nombre} ya existe` });
      }
      const ultimo = await app.saldoPeriodoRepo.getUltimoPeriodo();
      if (!ultimo) {
        return reply.status(400).send({ code: 'SIN_PERIODO_ANTERIOR', message: 'No se permite crear el primer periodo' });
      }
      // Verificar inmediato anterior
      const prev = month0 > 0 ? { y: year, m0: month0 - 1 } : { y: year - 1, m0: 11 };
      const esperadoAnterior = `${prev.y}${String(prev.m0 + 1).padStart(2, '0')}`;
      if (ultimo.nombre !== esperadoAnterior) {
        return reply.status(400).send({ code: 'GAP_NO_PERMITIDO', message: `Se esperaba que el último periodo fuera ${esperadoAnterior}` });
      }
    } catch (error) {
      app.log.error({ error: error instanceof Error ? error.message : String(error) }, 'Error en pre-validación de periodo');
      return reply.status(500).send({ error: 'Error interno' });
    }

    const jobId = `${JOB_PREFIX}${nombre}:${uuidv4()}`;
    jobService.createJob(jobId, fechaISO, 0);
    request.log.info({ jobId, nombre, fecha: fechaISO }, '[PERIODOS] Job creado (pending)');

    // Ejecutar en background
    const defaultUseCase = new CreatePeriodoUseCase(app.saldoPeriodoRepo, app.saldoRepo);
    const useCase: CreatePeriodoUseCase = (app as any).createPeriodoUseCase ?? defaultUseCase;
    (async () => {
      try {
        jobService.updateJob(jobId, { status: 'processing' });
        request.log.info({ jobId, nombre }, '[PERIODOS] Job iniciado (processing)');
        const result = await useCase.execute(fecha);
        request.log.info({ jobId, nombre, saldosCreados: result.saldosCreados, saldosVerificados: result.saldosVerificados }, '[PERIODOS] Job completado');
        jobService.updateJob(jobId, { status: 'completed', resultado: { ...result } as any });
      } catch (e) {
        const err = e as Error;
        let message = err.message;
        if (e instanceof PeriodoYaExisteError) message = e.message;
        if (e instanceof PeriodoSinAnteriorError) message = e.message;
        if (e instanceof PeriodoNoInmediatoAnteriorError) message = e.message;
        request.log.error({ err: message }, 'Error creando periodo');
        jobService.updateJob(jobId, { status: 'failed', error: message });
      }
    })();

    return reply.status(202).send({ jobId, status: 'pending', fecha });
  });

  // GET /api/v1/periodos/status/:jobId
  app.get<{ Params: { jobId: string } }>('/api/v1/periodos/status/:jobId', {
    schema: {
      tags: ['Periodos'],
      security: [{ apiKey: [] }],
      summary: 'Consultar estado de job de creación de periodo',
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { jobId } = request.params;
    const job = jobService.getJob(jobId);
    if (!job) return reply.status(404).send({ error: 'Job no encontrado', jobId });
    return job;
  });
}
