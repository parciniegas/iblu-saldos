import type { MovimientoContableCuenta } from './MovimientoContableCuenta.js';

export interface MovimientoContable {
  id: number;
  consecutivo: number;
  estado: string;
  fecha: Date;
  comprobanteId?: number;
  observacion?: string;
  createdAt?: Date;
  updatedAt?: Date;
  libroContableId?: number;
  modeloId?: number;
  modelo?: string;
  documento?: string;
  usuarioCreacionId?: number;
  usuarioModificacionId?: number;
  periodoId?: number;
  cerrado: boolean;
  hashConsecutivo?: number;
  consecutivoEstado?: string;
  cuentas?: MovimientoContableCuenta[];
}
