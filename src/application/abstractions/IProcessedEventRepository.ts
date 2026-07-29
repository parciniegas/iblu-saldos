export interface IProcessedEventRepository {
  createProcessing(
    tx: any,
    data: { correlationId: string; movimientoId?: number; periodoId: number; payloadHash?: string },
  ): Promise<void>;
  markCompleted(tx: any, correlationId: string): Promise<void>;
  getByCorrelationId(tx: any, correlationId: string): Promise<{ estado: string } | null>;
}
