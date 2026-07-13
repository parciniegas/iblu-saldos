import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { FileBackedJobService } from '../../src/api/services/FileBackedJobService.js';

describe('FileBackedJobService', () => {
  it('persiste y recarga jobs desde archivo', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saldos-jobs-'));
    const storePath = path.join(tempDir, 'jobs.json');

    const serviceA = new FileBackedJobService(storePath, 100);
    serviceA.createJob('job-1', '2024-01-01', 1000);
    serviceA.updateJob('job-1', { status: 'processing' });

    const serviceB = new FileBackedJobService(storePath, 100);
    const loaded = serviceB.getJob('job-1');

    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe('processing');
    expect(loaded?.fechaDesde).toBe('2024-01-01');
    expect(loaded?.batchSize).toBe(1000);
  });

  it('respeta límite máximo de jobs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saldos-jobs-'));
    const storePath = path.join(tempDir, 'jobs-limit.json');

    const service = new FileBackedJobService(storePath, 2);
    service.createJob('job-1', '2024-01-01', 1000);
    service.createJob('job-2', '2024-01-02', 1000);
    service.createJob('job-3', '2024-01-03', 1000);

    const jobs = service.listJobs({ limit: 10 });
    expect(jobs).toHaveLength(2);
    expect(jobs.some((job) => job.jobId === 'job-1')).toBe(false);
  });
});
