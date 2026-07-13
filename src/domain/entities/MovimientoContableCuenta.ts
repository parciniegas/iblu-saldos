import type { MovimientoContable } from './MovimientoContable.js';

export interface MovimientoContableCuenta {
  id: number;
  movimientoContableId: number;
  cuentaContableId: number;
  terceroId?: number;
  centroCostoId?: number;
  base: number;
  debito: number;
  credito: number;
  observacion?: string;
  createdAt?: Date;
  updatedAt?: Date;
  libroContableId?: number;
  unidadNegocioId?: number;
  trm: number;
  factorConversion: number;
  centroOperacionId?: number;
  categorizacionId?: number;
  modeloCarteraId?: number;
  modeloCartera?: string;
  conceptoTributarioId?: number;
  movimientoContable?: MovimientoContable;
}
