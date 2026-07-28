import type { MovimientoContableCuentaAgrupadaRow } from './MovimientoContableCuentaAgrupadaRow.js';

export type MovimientoContableEvent = {
  id: number;
  fecha: Date;
  estado: string;
  PeriodoId: number;
  cuentas: Omit<MovimientoContableCuentaAgrupadaRow, 'RegistrosMovimientoContableCuenta' | 'PeriodoId'>[];
  Estado: 'Creado' | 'Borrado';
  CorrelationId: string;
};
