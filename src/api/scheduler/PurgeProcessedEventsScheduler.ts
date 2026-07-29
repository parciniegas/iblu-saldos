import cron from 'node-cron';
import pino from 'pino';
import { prisma } from '../../infrastructure/persistence/PrismaService.js';

export type PurgeConfig = {
  enabled: boolean;
  cron: string;
  retentionDays: number;
  chunkSize: number;
  stuckHours: number;
  optimizeAfterDeletes: number;
};

export class PurgeProcessedEventsScheduler {
  private task: any = null;
  private readonly logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger = logger ?? pino({ name: 'saldos-api' });
  }

  start(config: PurgeConfig): void {
    if (!config.enabled) {
      this.logger.info('[PURGE] Purga deshabilitada');
      return;
    }

    this.stop();
    this.task = cron.schedule(config.cron, async () => {
      await this.runOnce(config);
    });

    this.logger.info({ cron: config.cron }, '[PURGE] Scheduler de purga iniciado');
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async runOnce(config: PurgeConfig): Promise<void> {
    const lockName = 'processed_events_purge';
    try {
      const lock = (await prisma.$queryRaw<any>`SELECT GET_LOCK(${lockName}, 0) AS locked`) as Array<{ locked: number }>;
      const locked = Array.isArray(lock) && lock[0] && Number((lock[0] as any).locked) === 1;
      if (!locked) {
        this.logger.info('[PURGE] Otro proceso tiene el lock. Saliendo.');
        return;
      }

      const start = Date.now();
      const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);
      const stuckCutoff = new Date(Date.now() - config.stuckHours * 60 * 60 * 1000);
      const chunk = Math.max(100, config.chunkSize);

      let totalCompleted = 0;
      // Purga completed
      while (true) {
        const affected = (await prisma.$executeRaw`
          DELETE FROM processed_events
          WHERE estado = 'completed' AND created_at < ${cutoff}
          LIMIT ${chunk}
        `) as unknown as number | bigint;
        const count = Number(affected ?? 0);
        totalCompleted += count;
        if (count < chunk) break;
      }

      let totalStuck = 0;
      while (true) {
        const affected = (await prisma.$executeRaw`
          DELETE FROM processed_events
          WHERE estado = 'processing' AND created_at < ${stuckCutoff}
          LIMIT ${chunk}
        `) as unknown as number | bigint;
        const count = Number(affected ?? 0);
        totalStuck += count;
        if (count < chunk) break;
      }

      const total = totalCompleted + totalStuck;
      if (total >= (config.optimizeAfterDeletes ?? Number.POSITIVE_INFINITY)) {
        try {
          await prisma.$executeRawUnsafe('OPTIMIZE TABLE processed_events');
        } catch (optErr) {
          this.logger.warn({ error: optErr instanceof Error ? optErr.message : String(optErr) }, '[PURGE] Error en OPTIMIZE TABLE');
        }
      }

      const durationMs = Date.now() - start;
      this.logger.info(
        { totalCompleted, totalStuck, durationMs },
        '[PURGE] Purga de processed_events completada',
      );
    } catch (error) {
      this.logger.error({ error: error instanceof Error ? error.message : String(error) }, '[PURGE] Error en purga');
    } finally {
      try {
        await prisma.$queryRaw<any>`SELECT RELEASE_LOCK('processed_events_purge')`;
      } catch {
        // ignore
      }
    }
  }
}
