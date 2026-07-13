import { z } from 'zod';

const fechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido. Use yyyy-MM-dd');

export const saldosQueueMessageV1Schema = z.object({
  version: z.literal(1),
  fechaDesde: fechaSchema,
  batchSize: z.number().int().positive(),
});

export const saldosQueueMessageLegacySchema = z.object({
  fechaDesde: fechaSchema,
  batchSize: z.number().int().positive(),
});

export const saldosQueueMessageSchema = z.union([
  saldosQueueMessageV1Schema,
  saldosQueueMessageLegacySchema,
]);

export type SaldosQueueMessageInput = z.infer<typeof saldosQueueMessageSchema>;

export type SaldosQueueMessage = {
  version: 1;
  fechaDesde: string;
  batchSize: number;
};

export function toSaldosQueueMessage(input: SaldosQueueMessageInput): SaldosQueueMessage {
  if ('version' in input) {
    return input;
  }

  return {
    version: 1,
    fechaDesde: input.fechaDesde,
    batchSize: input.batchSize,
  };
}
