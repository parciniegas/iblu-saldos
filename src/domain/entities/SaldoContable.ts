export interface SaldoContable {
  id: number;
  periodoId: number;
  class?: string;
  entidadId?: number;
  terceroId?: number;
  cuentaContableId?: number;
  centroCostoId?: number;
  saldoInicialDebito: number;
  saldoInicialCredito: number;
  debito: number;
  credito: number;
  saldoFinalDebito: number;
  saldoFinalCredito: number;
  createdAt?: Date;
  updatedAt?: Date;
  libroContableId?: number;
  unidadNegocioId?: number;
  centroOperacionId?: number;
  categorizacionId?: number;
  cierre: boolean;
  modeloCarteraId?: number;
  modeloCartera?: string;
  conceptoTributarioId?: number;
}
