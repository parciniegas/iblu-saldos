import fs from 'node:fs';
import path from 'node:path';
import type { Job, JobService, JobStatus } from './JobService.js';

const DEFAULT_MAX_JOBS = 1000;
const DEFAULT_MAX_AGE_HOURS = 24;

type SerializedJob = Omit<Job, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

function serializeJob(job: Job): SerializedJob {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function deserializeJob(job: SerializedJob): Job {
  return {
    ...job,
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt),
  };
}

export class FileBackedJobService implements JobService {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly filePath: string,
    private readonly maxJobs: number = DEFAULT_MAX_JOBS,
  ) {
    this.load();
  }

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
    this.trimToMaxJobs();
    this.persist();

    return { ...job };
  }

  updateJob(jobId: string, updates: Partial<Pick<Job, 'status' | 'resultado' | 'error' | 'periodosProcesados' | 'movimientosProcesados' | 'movimientosCuentaProcesados' | 'tiempoTotalMs' | 'eta'>>): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    Object.assign(job, updates, { updatedAt: new Date() });
    this.persist();

    return { ...job };
  }

  getJob(jobId: string): Job | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  listJobs(filters?: { status?: JobStatus; limit?: number }): Job[] {
    const limit = filters?.limit ?? 50;
    let jobs = Array.from(this.jobs.values());

    if (filters?.status) {
      jobs = jobs.filter((job) => job.status === filters.status);
    }

    jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return jobs.slice(0, limit).map((job) => ({ ...job }));
  }

  cleanup(maxAgeHours: number = DEFAULT_MAX_AGE_HOURS): void {
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

    for (const [jobId, job] of this.jobs) {
      if (job.createdAt.getTime() < cutoff) {
        this.jobs.delete(jobId);
      }
    }

    this.persist();
  }

  private trimToMaxJobs(): void {
    if (this.jobs.size <= this.maxJobs) return;

    const sorted = Array.from(this.jobs.values()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const toRemove = sorted.slice(0, this.jobs.size - this.maxJobs);

    for (const job of toRemove) {
      this.jobs.delete(job.jobId);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SerializedJob[];

      this.jobs.clear();
      for (const item of parsed) {
        const job = deserializeJob(item);
        this.jobs.set(job.jobId, job);
      }
    } catch {
      this.jobs.clear();
    }
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    const serialized = Array.from(this.jobs.values()).map(serializeJob);
    fs.writeFileSync(this.filePath, JSON.stringify(serialized, null, 2), 'utf-8');
  }
}
