import { prisma } from './PrismaService.js';
import type { IMovimientoContableRepository } from '../../application/abstractions/IMovimientoContableRepository.js';
import type { MovimientoContableCuentaAgrupadaRow } from '../../application/contracts/MovimientoContableCuentaAgrupadaRow.js';
import type { MovimientoContable } from '../../domain/entities/MovimientoContable.js';

export class MovimientoContableRepository implements IMovimientoContableRepository {
  async getCuentasAgrupadasPorMovimientos(movimientoIds: number[]): Promise<MovimientoContableCuentaAgrupadaRow[]> {
    if (movimientoIds.length === 0) return [];

    const rows = await prisma.movimientoContableCuenta.groupBy({
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
      where: {
        movimientoContableId: { in: movimientoIds },
      },
      _sum: {
        debito: true,
        credito: true,
      },
      _count: {
        id: true,
      },
    });

    return rows.map((row) => ({
      MovimientoContableId: Number(row.movimientoContableId),
      PeriodoId: undefined,
      CuentaContableId: Number(row.cuentaContableId),
      TerceroId: row.terceroId != null ? Number(row.terceroId) : undefined,
      CentroCostoId: row.centroCostoId != null ? Number(row.centroCostoId) : undefined,
      LibroContableId: row.libroContableId != null ? Number(row.libroContableId) : undefined,
      UnidadNegocioId: row.unidadNegocioId != null ? Number(row.unidadNegocioId) : undefined,
      CentroOperacionId: row.centroOperacionId != null ? Number(row.centroOperacionId) : undefined,
      CategorizacionId: row.categorizacionId != null ? Number(row.categorizacionId) : undefined,
      ModeloCarteraId: row.modeloCarteraId != null ? Number(row.modeloCarteraId) : undefined,
      ModeloCartera: row.modeloCartera ?? undefined,
      ConceptoTributarioId: row.conceptoTributarioId != null ? Number(row.conceptoTributarioId) : undefined,
      Debito: Number(row._sum.debito ?? 0),
      Credito: Number(row._sum.credito ?? 0),
      RegistrosMovimientoContableCuenta: row._count.id,
    }));
  }

  async getPeriodosDesdeFecha(fechaDesde: Date): Promise<number[]> {
    const rows = await prisma.movimientoContable.findMany({
      select: { periodoId: true },
      where: {
        fecha: { gte: fechaDesde },
        periodoId: { not: null },
      },
      distinct: ['periodoId'],
      orderBy: { periodoId: 'asc' },
    });

    return rows.map((r) => Number(r.periodoId!));
  }

  async getBatchByPeriodo(periodoId: number, batchSize: number, lastId?: number): Promise<MovimientoContable[]> {
    const where: { periodoId: number; id?: { gt: number } } = {
      periodoId,
    };

    if (lastId !== undefined) {
      where.id = { gt: lastId };
    }

    const movimientos = await prisma.movimientoContable.findMany({
      where,
      orderBy: { id: 'asc' },
      take: batchSize,
    });

    return movimientos.map((m): MovimientoContable => ({
      id: Number(m.id),
      consecutivo: Number(m.consecutivo),
      estado: m.estado,
      fecha: m.fecha,
      comprobanteId: m.comprobanteId != null ? Number(m.comprobanteId) : undefined,
      documento: m.documento ?? undefined,
      updatedAt: m.updatedAt ?? undefined,
      usuarioCreacionId: m.usuarioCreacionId != null ? Number(m.usuarioCreacionId) : undefined,
      usuarioModificacionId: m.usuarioModificacionId != null ? Number(m.usuarioModificacionId) : undefined,
      periodoId: m.periodoId != null ? Number(m.periodoId) : undefined,
      libroContableId: m.libroContableId != null ? Number(m.libroContableId) : undefined,
      cerrado: m.cerrado,
    }));
  }
}
