import type { SaldoContableKey } from '../contracts/SaldoContableKey.js';
import type { SaldoContableUpdateValues } from '../contracts/SaldoContableUpdateValues.js';
import type { SaldoContable } from '../../domain/entities/SaldoContable.js';

export interface ISaldoContableRepository {
  getByKey(key: SaldoContableKey): Promise<SaldoContable | null>;
  updateByKey(key: SaldoContableKey, values: SaldoContableUpdateValues): Promise<void>;
  getByPeriodo(periodoId: number): Promise<SaldoContable[]>;
  bulkUpdate(saldos: SaldoContable[]): Promise<void>;
}
