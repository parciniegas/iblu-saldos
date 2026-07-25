export type SaldoContablePeriodo = {
  id: number;
  nombre: string;
  periodoInicio?: Date;
  periodoFin?: Date;
  cierre: boolean;
  cierreAnio: boolean;
};
