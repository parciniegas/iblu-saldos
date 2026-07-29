import type { IProcessedEventRepository } from '../../application/abstractions/IProcessedEventRepository.js';

export class ProcessedEventRepository implements IProcessedEventRepository {
  async createProcessing(
    tx: any,
    data: { correlationId: string; movimientoId?: number; periodoId: number; payloadHash?: string },
  ): Promise<void> {
    await tx.processedEvent.create({
      data: {
        correlationId: data.correlationId,
        movimientoId: data.movimientoId != null ? BigInt(data.movimientoId) : null,
        periodoId: BigInt(data.periodoId),
        estado: 'processing',
        payloadHash: data.payloadHash ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  async markCompleted(tx: any, correlationId: string): Promise<void> {
    await tx.processedEvent.update({
      where: { correlationId },
      data: { estado: 'completed', updatedAt: new Date() },
    });
  }

  async getByCorrelationId(tx: any, correlationId: string): Promise<{ estado: string } | null> {
    const row = await tx.processedEvent.findUnique({ where: { correlationId }, select: { estado: true } });
    return row ? { estado: row.estado } : null;
  }
}
