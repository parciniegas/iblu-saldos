import type { SaldoContableKey } from '../contracts/SaldoContableKey.js';
import type { SaldoContableUpdateValues } from '../contracts/SaldoContableUpdateValues.js';
import type { SaldoContable } from '../../domain/entities/SaldoContable.js';

export interface ISaldoContableRepository {
  getByKey(key: SaldoContableKey): Promise<SaldoContable | null>;
  updateByKey(key: SaldoContableKey, values: SaldoContableUpdateValues): Promise<void>;
  getByPeriodo(periodoId: number): Promise<SaldoContable[]>;
  bulkUpdate(saldos: SaldoContable[]): Promise<void>;
  // Crea saldos para newPeriodoId copiando desde prevPeriodoId:
  // saldoInicial = saldoFinal previo; debito/credito = 0; saldoFinal = saldoInicial; cierre = false
  copyFromPeriodo(prevPeriodoId: number, newPeriodoId: number): Promise<number>;
  countByPeriodo(periodoId: number): Promise<number>;
}
