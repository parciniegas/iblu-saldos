import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { CreatePeriodoUseCase } from '../../application/useCases/CreatePeriodoUseCase.js';
import { createRequire } from 'node:module';

const JOB_PREFIX = 'crear-periodo:';

export class PeriodoScheduler {
  private task: any | null = null;

  start(app: FastifyInstance, cronExpr: string): void {
    if (this.task) return;
    const logger = app.log;
    logger.info({ cronExpr }, '[SCHEDULER] Iniciando scheduler de creación de periodos');
    // Carga dinámica de node-cron mediante require para evitar error de tipos si no está instalado
    const require = createRequire(import.meta.url);
    let cronMod: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cronMod = require('node-cron');
    } catch (e) {
      logger.warn({ error: (e as Error).message }, '[SCHEDULER] node-cron no disponible, scheduler deshabilitado');
      return;
    }

    this.task = cronMod.schedule(cronExpr, async () => {
      try {
        const now = new Date();
        const yyyy = now.getUTCFullYear();
        const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(now.getUTCDate()).padStart(2, '0');
        const fechaISO = `${yyyy}-${mm}-${dd}`;

        const jobService: any = (app as any).jobService;
        if (!jobService) {
          logger.warn('[SCHEDULER] jobService no disponible, omitiendo');
          return;
        }

        const conflict = jobService
          .listJobs({ limit: 50 })
          .find((j: any) => (j.status === 'pending' || j.status === 'processing') && j.jobId.startsWith(JOB_PREFIX));
        if (conflict) {
          logger.warn({ runningJobId: conflict.jobId }, '[SCHEDULER] Ya existe job crear-periodo en ejecución, omitiendo');
          return;
        }

        const jobId = `${JOB_PREFIX}${yyyy}${mm}:${uuidv4()}`;
        jobService.createJob(jobId, fechaISO, 0);
        logger.info({ jobId, fechaISO }, '[SCHEDULER] Job crear-periodo creado (pending)');

        const useCase: CreatePeriodoUseCase = (app as any).createPeriodoUseCase ?? new CreatePeriodoUseCase(app.saldoPeriodoRepo, app.saldoRepo);

        (async () => {
          try {
            jobService.updateJob(jobId, { status: 'processing' });
            logger.info({ jobId, fechaISO }, '[SCHEDULER] Job crear-periodo iniciado (processing)');
            const result = await useCase.execute(new Date(fechaISO + 'T00:00:00.000Z'));
            logger.info({ jobId, result }, '[SCHEDULER] Job crear-periodo completado');
            jobService.updateJob(jobId, { status: 'completed', resultado: result as any });
          } catch (e) {
            const err = e as Error;
            logger.error({ jobId, error: err.message }, '[SCHEDULER] Error ejecutando job crear-periodo');
            jobService.updateJob(jobId, { status: 'failed', error: err.message });
          }
        })();
      } catch (e) {
        const err = e as Error;
        app.log.error({ error: err.message }, '[SCHEDULER] Error en tick');
      }
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }
}
