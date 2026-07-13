export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type Job = {
  jobId: string;
  status: JobStatus;
  fechaDesde: string;
  batchSize: number;
  periodosProcesados: number;
  movimientosProcesados: number;
  movimientosCuentaProcesados: number;
  tiempoTotalMs: number;
  eta?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  resultado?: {
    periodosProcesados: number;
    movimientosProcesados: number;
    movimientosCuentaProcesados: number;
    tiempoTotalMs: number;
    eta?: string;
  };
};

export type JobService = {
  createJob(jobId: string, fechaDesde: string, batchSize: number): Job;
  updateJob(jobId: string, updates: Partial<Pick<Job, 'status' | 'resultado' | 'error' | 'periodosProcesados' | 'movimientosProcesados' | 'movimientosCuentaProcesados' | 'tiempoTotalMs' | 'eta'>>): Job | null;
  getJob(jobId: string): Job | null;
  listJobs(filters?: { status?: JobStatus; limit?: number }): Job[];
  cleanup(maxAgeHours?: number): void;
};
