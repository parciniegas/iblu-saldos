export type SaldoContablePeriodo = {
  id: number;
  nombre: string;
  periodoInicio?: Date;
  periodoFin?: Date;
  cierre: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  usuarioCreacionId?: number;
  usuarioModificacionId?: number;
  recalculoLogico: boolean;
  cierreAnio: boolean;
  cierreContable: boolean;
};
