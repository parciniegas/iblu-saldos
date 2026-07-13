import type { MovimientoContableCuentaAgrupadaRow } from '../contracts/MovimientoContableCuentaAgrupadaRow.js';
import type { MovimientoContable } from '../../domain/entities/MovimientoContable.js';

export interface IMovimientoContableRepository {
  getCuentasAgrupadasPorMovimientos(movimientoIds: number[]): Promise<MovimientoContableCuentaAgrupadaRow[]>;
  getPeriodosDesdeFecha(fechaDesde: Date): Promise<number[]>;
  getBatchByPeriodo(periodoId: number, batchSize: number, lastId?: number): Promise<MovimientoContable[]>;
}
