import type { Job, JobService, JobStatus } from './JobService.js';

const MAX_JOBS = 100;
const DEFAULT_MAX_AGE_HOURS = 24;

export class InMemoryJobService implements JobService {
  private jobs = new Map<string, Job>();

  createJob(jobId: string, fechaDesde: string, batchSize: number): Job {
    const now = new Date();
    const job: Job = {
      jobId,
      status: 'pending',
      fechaDesde,
      batchSize,
      periodosProcesados: 0,
      movimientosProcesados: 0,
      movimientosCuentaProcesados: 0,
      tiempoTotalMs: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(jobId, job);

    if (this.jobs.size > MAX_JOBS) {
      const keys = Array.from(this.jobs.keys());
      const toDelete = keys.slice(0, this.jobs.size - MAX_JOBS);
      for (const key of toDelete) {
        this.jobs.delete(key);
      }
    }

    return job;
  }

  updateJob(jobId: string, updates: Partial<Pick<Job, 'status' | 'resultado' | 'error' | 'periodosProcesados' | 'movimientosProcesados' | 'movimientosCuentaProcesados' | 'tiempoTotalMs' | 'eta'>>): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    Object.assign(job, updates, { updatedAt: new Date() });

    return job;
  }

  getJob(jobId: string): Job | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  listJobs(filters?: { status?: JobStatus; limit?: number }): Job[] {
    const limit = filters?.limit ?? 50;
    let jobs = Array.from(this.jobs.values());

    if (filters?.status) {
      jobs = jobs.filter((j) => j.status === filters.status);
    }

    jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return jobs.slice(0, limit).map((j) => ({ ...j }));
  }

  cleanup(maxAgeHours: number = DEFAULT_MAX_AGE_HOURS): void {
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

    for (const [jobId, job] of this.jobs) {
      if (job.createdAt.getTime() < cutoff) {
        this.jobs.delete(jobId);
      }
    }
  }
}
