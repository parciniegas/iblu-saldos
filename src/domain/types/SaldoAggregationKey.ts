import type { SaldoBaseKey } from './SaldoBaseKey.js';

export type SaldoAggregationKey = SaldoBaseKey & {
  PeriodoId: number;
};
