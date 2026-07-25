import type { SaldoContablePeriodo } from '../contracts/SaldoContablePeriodo.js';

// Repositorio de periodos contables
export interface ISaldoContablePeriodoRepository {
  // Devuelve los periodos cuyo periodoInicio >= fechaDesde, ordenados por nombre ASC
  getPeriodosDesdeFechaOrdenados(fechaDesde: Date): Promise<SaldoContablePeriodo[]>;
}
