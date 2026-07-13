import { describe, it, expect } from 'vitest';
import {
  saldosQueueMessageSchema,
  toSaldosQueueMessage,
} from '../../src/application/contracts/SaldosQueueMessage.js';

describe('SaldosQueueMessage contract', () => {
  it('acepta mensajes v1', () => {
    const parsed = saldosQueueMessageSchema.safeParse({
      version: 1,
      fechaDesde: '2024-01-01',
      batchSize: 1000,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const normalized = toSaldosQueueMessage(parsed.data);
    expect(normalized).toEqual({
      version: 1,
      fechaDesde: '2024-01-01',
      batchSize: 1000,
    });
  });

  it('normaliza mensajes legacy', () => {
    const parsed = saldosQueueMessageSchema.safeParse({
      fechaDesde: '2024-01-01',
      batchSize: 1500,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const normalized = toSaldosQueueMessage(parsed.data);
    expect(normalized).toEqual({
      version: 1,
      fechaDesde: '2024-01-01',
      batchSize: 1500,
    });
  });

  it('rechaza mensajes inválidos', () => {
    const parsed = saldosQueueMessageSchema.safeParse({
      version: 1,
      fechaDesde: '2024/01/01',
      batchSize: -10,
    });

    expect(parsed.success).toBe(false);
  });
});
