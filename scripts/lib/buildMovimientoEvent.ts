import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export type EventoEstado = 'Creado' | 'Borrado';

export async function buildMovimientoEvent(
  prisma: PrismaClient,
  movimientoCuentaOrMovimientoId: number,
  estado: EventoEstado = 'Creado',
) {
  const mc = await prisma.movimientoContableCuenta.findUnique({ where: { id: BigInt(movimientoCuentaOrMovimientoId) } });
  let movimientoId: number;
  let mov = null as Awaited<ReturnType<typeof prisma.movimientoContable.findUnique>> | null;
  if (!mc) {
    // Interpretar como MovimientoContable.id
    const movTry = await prisma.movimientoContable.findUnique({ where: { id: BigInt(movimientoCuentaOrMovimientoId) } });
    if (!movTry) {
      throw new Error(`No se encontró MovimientoContableCuenta ni MovimientoContable con id=${movimientoCuentaOrMovimientoId}`);
    }
    movimientoId = Number(movTry.id);
    mov = movTry;
  } else {
    movimientoId = Number(mc.movimientoContableId);
    mov = await prisma.movimientoContable.findUnique({ where: { id: BigInt(movimientoId) } });
  }

  if (!mov) {
    throw new Error(`No se encontró MovimientoContable id=${movimientoId}`);
  }

  // Determinar PeriodoId
  let periodoId = mov.periodoId != null ? Number(mov.periodoId) : undefined;
  if (periodoId == null) {
    const fecha = mov.fecha as unknown as Date;
    const periodo = await prisma.saldoContablePeriodo.findFirst({
      where: {
        periodoInicio: { lte: fecha },
        OR: [{ periodoFin: null }, { periodoFin: { gte: fecha } }],
      },
      orderBy: { periodoInicio: 'desc' },
    });
    if (!periodo) {
      throw new Error('No se pudo determinar PeriodoId por fecha');
    }
    periodoId = Number(periodo.id);
  }

  const grouped = await prisma.movimientoContableCuenta.groupBy({
    by: [
      'movimientoContableId',
      'cuentaContableId',
      'terceroId',
      'centroCostoId',
      'libroContableId',
      'unidadNegocioId',
      'centroOperacionId',
      'categorizacionId',
      'modeloCarteraId',
      'modeloCartera',
      'conceptoTributarioId',
    ],
    where: { movimientoContableId: BigInt(movimientoId) },
    _sum: { debito: true, credito: true },
    _count: { id: true },
  });

  const cuentas = grouped.map((g) => ({
    MovimientoContableId: Number(g.movimientoContableId),
    CuentaContableId: Number(g.cuentaContableId),
    TerceroId: g.terceroId != null ? Number(g.terceroId) : null,
    CentroCostoId: g.centroCostoId != null ? Number(g.centroCostoId) : null,
    LibroContableId: g.libroContableId != null ? Number(g.libroContableId) : null,
    UnidadNegocioId: g.unidadNegocioId != null ? Number(g.unidadNegocioId) : null,
    CentroOperacionId: g.centroOperacionId != null ? Number(g.centroOperacionId) : null,
    CategorizacionId: g.categorizacionId != null ? Number(g.categorizacionId) : null,
    ModeloCarteraId: g.modeloCarteraId != null ? Number(g.modeloCarteraId) : null,
    ModeloCartera: g.modeloCartera ?? null,
    ConceptoTributarioId: g.conceptoTributarioId != null ? Number(g.conceptoTributarioId) : null,
    Debito: Number(g._sum.debito ?? 0),
    Credito: Number(g._sum.credito ?? 0),
  }));

  return {
    id: movimientoId,
    CorrelationId: randomUUID(),
    fecha: mov.fecha,
    estado: mov.estado,
    Estado: estado,
    PeriodoId: periodoId,
    cuentas,
  };
}
