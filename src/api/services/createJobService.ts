import path from 'node:path';
import { FileBackedJobService } from './FileBackedJobService.js';
import { InMemoryJobService } from './InMemoryJobService.js';
import type { JobService } from './JobService.js';

function resolveStorePath(): string {
  const configured = process.env.SALDOS_JOB_STORE_PATH;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }

  return path.resolve('logs/jobs-store.json');
}

export function createJobService(): JobService {
  try {
    return new FileBackedJobService(resolveStorePath());
  } catch {
    return new InMemoryJobService();
  }
}
