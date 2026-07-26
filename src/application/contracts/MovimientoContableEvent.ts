import type { MovimientoContableCuentaAgrupadaRow } from './MovimientoContableCuentaAgrupadaRow.js';

export type MovimientoContableEvent = {
  id: number;
  fecha: Date;
  estado: string;
  cuentas: Omit<MovimientoContableCuentaAgrupadaRow, 'RegistrosMovimientoContableCuenta'>[];
  Estado: 'Creado' | 'Borrado';
};
