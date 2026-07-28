import { z } from 'zod';

// Zod schema for strict validation of MovimientoContableEvent payloads from RabbitMQ
export const CuentaSchema = z
  .object({
    MovimientoContableId: z.number().int(),
    CuentaContableId: z.number().int(),
    TerceroId: z.number().int().nullable(),
    CentroCostoId: z.number().int().nullable(),
    LibroContableId: z.number().int().nullable(),
    UnidadNegocioId: z.number().int().nullable(),
    CentroOperacionId: z.number().int().nullable(),
    CategorizacionId: z.number().int().nullable(),
    ModeloCarteraId: z.number().int().nullable(),
    ModeloCartera: z.string().nullable().optional(),
    ConceptoTributarioId: z.number().int().nullable().optional(),
    Debito: z.number(),
    Credito: z.number(),
  })
  .strict();

export const MovimientoContableEventSchema = z
  .object({
    id: z.number().int(),
    fecha: z.union([z.string(), z.date()]),
    estado: z.string(),
    Estado: z.enum(['Creado', 'Borrado']),
    CorrelationId: z.string().min(1),
    PeriodoId: z.number().int(),
    cuentas: z.array(CuentaSchema).min(1),
  })
  .strict();

export type MovimientoContableEventInput = z.input<typeof MovimientoContableEventSchema>;

export function parseAndNormalizeMovimientoEvent(input: unknown) {
  const parsed = MovimientoContableEventSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    const err = new Error(`Evento inválido: ${issues}`);
    (err as any).code = 'INVALID_EVENT_PAYLOAD';
    throw err;
  }
  const v = parsed.data;
  const fecha = v.fecha instanceof Date ? v.fecha : new Date(v.fecha);
  if (Number.isNaN(fecha.getTime())) {
    const err = new Error('Evento inválido: fecha no parseable');
    (err as any).code = 'INVALID_EVENT_PAYLOAD';
    throw err;
  }
  return {
    ...v,
    fecha,
  };
}
