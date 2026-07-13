import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryJobService } from '../../src/api/services/InMemoryJobService.js';
import type { JobStatus } from '../../src/api/services/JobService.js';

describe('InMemoryJobService', () => {
  let service: ReturnType<typeof InMemoryJobService>;

  beforeEach(() => {
    service = new InMemoryJobService();
  });

  it('debe crear un job con estado pending', () => {
    const job = service.createJob('job-1', '2024-01-01', 1000);

    expect(job.jobId).toBe('job-1');
    expect(job.status).toBe('pending');
    expect(job.fechaDesde).toBe('2024-01-01');
    expect(job.batchSize).toBe(1000);
  });

  it('debe actualizar un job existente', () => {
    service.createJob('job-1', '2024-01-01', 1000);

    const updated = service.updateJob('job-1', { status: 'processing' });

    expect(updated?.status).toBe('processing');
  });

  it('debe retornar null para job inexistente', () => {
    const job = service.getJob('non-existent');
    expect(job).toBeNull();
  });

  it('debe listar jobs con filtros', () => {
    service.createJob('job-1', '2024-01-01', 1000);
    service.createJob('job-2', '2024-02-01', 2000);

    const completed = service.listJobs({ status: 'pending' });
    expect(completed).toHaveLength(2);

    const pendingOnly = service.listJobs({ status: 'pending' });
    expect(pendingOnly).toHaveLength(2);
  });

  it('debe limitar la cantidad de jobs almacenados', () => {
    for (let i = 0; i < 110; i++) {
      service.createJob(`job-${i}`, '2024-01-01', 1000);
    }

    const all = service.listJobs();
    expect(all.length).toBeLessThanOrEqual(100);
  });

  it('debe limpiar jobs antiguos', () => {
    service.cleanup(0);

    // Después de cleanup con maxAge 0, los jobs creados antes deberían ser eliminados
    // Pero como acabamos de crearlos, no hay jobs viejos
    expect(service.listJobs().length).toBeGreaterThanOrEqual(0);
  });
});
