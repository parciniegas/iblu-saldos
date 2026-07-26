import type { SaldoContablePeriodo } from '../contracts/SaldoContablePeriodo.js';

// Repositorio de periodos contables
export interface ISaldoContablePeriodoRepository {
  // Devuelve los periodos cuyo periodoInicio >= fechaDesde, ordenados por nombre ASC
  getPeriodosDesdeFechaOrdenados(fechaDesde: Date): Promise<SaldoContablePeriodo[]>;
  existsByNombre(nombre: string): Promise<boolean>;
  getByNombre(nombre: string): Promise<SaldoContablePeriodo | null>;
  getUltimoPeriodo(): Promise<SaldoContablePeriodo | null>;
  create(nombre: string, periodoInicio: Date, periodoFin: Date): Promise<{ id: number }>;
}
