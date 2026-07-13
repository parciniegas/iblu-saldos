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

    return movimientos.map((m) => ({
      id: Number(m.id),
      consecutivo: Number(m.consecutivo),
      estado: m.estado,
      fecha: m.fecha,
      comprobanteId: m.comprobanteId != null ? Number(m.comprobanteId) : null,
      documento: m.documento != null ? m.documento : undefined,
      updatedAt: m.updatedAt != null ? m.updatedAt : undefined,
      usuarioCreacionId: m.usuarioCreacionId != null ? Number(m.usuarioCreacionId) : null,
      usuarioModificacionId: m.usuarioModificacionId != null ? Number(m.usuarioModificacionId) : null,
      periodoId: m.periodoId != null ? Number(m.periodoId) : null,
      libroContableId: m.libroContableId != null ? Number(m.libroContableId) : null,
      tipoDocumentoId: m.tipoDocumentoId != null ? Number(m.tipoDocumentoId) : null,
      conceptoTributarioId: m.conceptoTributarioId != null ? Number(m.conceptoTributarioId) : null,
      sucursalId: m.sucursalId != null ? Number(m.sucursalId) : null,
      centroOperacionId: m.centroOperacionId != null ? Number(m.centroOperacionId) : null,
      tipoMonedaId: m.tipoMonedaId != null ? Number(m.tipoMonedaId) : null,
      tipoJornalId: m.tipoJornalId != null ? Number(m.tipoJornalId) : null,
      unidadNegocioId: m.unidadNegocioId != null ? Number(m.unidadNegocioId) : null,
      entidadId: m.entidadId != null ? Number(m.entidadId) : null,
      direccionDocumentoId: m.direccionDocumentoId != null ? Number(m.direccionDocumentoId) : null,
      centroCostoId: m.centroCostoId != null ? Number(m.centroCostoId) : null,
      conceptoId: m.conceptoId != null ? Number(m.conceptoId) : null,
      valorOperacion: m.valorOperacion != null ? Number(m.valorOperacion) : null,
      valorNoGenerarRegistro: m.valorNoGenerarRegistro != null ? Number(m.valorNoGenerarRegistro) : null,
      valorNoAjustarEnTRM: m.valorNoAjustarEnTRM != null ? Number(m.valorNoAjustarEnTRM) : null,
      iva: m.iva != null ? Number(m.iva) : null,
      retencion1p: m.retencion1p != null ? Number(m.retencion1p) : null,
      retencion2p: m.retencion2p != null ? Number(m.retencion2p) : null,
      retencionPropia: m.retencionPropia != null ? Number(m.retencionPropia) : null,
      retencionExterior: m.retencionExterior != null ? Number(m.retencionExterior) : null,
      otrosRetenciones: m.otrosRetenciones != null ? Number(m.otrosRetenciones) : null,
      valorIvaCredito: m.valorIvaCredito != null ? Number(m.valorIvaCredito) : null,
      total: m.total != null ? Number(m.total) : null,
      tipoContraparteId: m.tipoContraparteId != null ? Number(m.tipoContraparteId) : null,
      valorTercero: m.valorTercero != null ? Number(m.valorTercero) : null,
      tipoRegimenFiscalId: m.tipoRegimenFiscalId != null ? Number(m.tipoRegimenFiscalId) : null,
      tipoContingenciaId: m.tipoContingenciaId != null ? Number(m.tipoContingenciaId) : null,
      tipoLugarExpedicionId: m.tipoLugarExpedicionId != null ? Number(m.tipoLugarExpedicionId) : null,
      tipoActoOEventoId: m.tipoActoOEventoId != null ? Number(m.tipoActoOEventoId) : null,
      tipoDocumentoOriginarioId: m.tipoDocumentoOriginarioId != null ? Number(m.tipoDocumentoOriginarioId) : null,
      tipoDeclaracionId: m.tipoDeclaracionId != null ? Number(m.tipoDeclaracionId) : null,
      tipoTractamientoId: m.tipoTractamientoId != null ? Number(m.tipoTractamientoId) : null,
      tipoReteFuenteId: m.tipoReteFuenteId != null ? Number(m.tipoReteFuenteId) : null,
      tipoRetePerIvaId: m.tipoRetePerIvaId != null ? Number(m.tipoRetePerIvaId) : null,
      valorRetRenta: m.valorRetRenta != null ? Number(m.valorRetRenta) : null,
      valorRetIva: m.valorRetIva != null ? Number(m.valorRetIva) : null,
      valorRetIiic: m.valorRetIiic != null ? Number(m.valorRetIiic) : null,
      valorAnticipoPagador: m.valorAnticipoPagador != null ? Number(m.valorAnticipoPagador) : null,
      tipoMonedaOperacionId: m.tipoMonedaOperacionId != null ? Number(m.tipoMonedaOperacionId) : null,
      tipoReteAgenteId: m.tipoReteAgenteId != null ? Number(m.tipoReteAgenteId) : null,
      tipoRetencionId: m.tipoRetencionId != null ? Number(m.tipoRetencionId) : null,
      cerrado: m.cerrado,
      fechaVencimiento: m.fechaVencimiento != null ? m.fechaVencimiento : undefined,
      fechaAutorizacion: m.fechaAutorizacion != null ? m.fechaAutorizacion : undefined,
      numeroAutorizacion: m.numeroAutorizacion != null ? m.numeroAutorizacion : undefined,
      fechaEmisionFTE: m.fechaEmisionFTE != null ? m.fechaEmisionFTE : undefined,
      fechaEmisionFTERmAnulado: m.fechaEmisionFTERmAnulado != null ? m.fechaEmisionFTERmAnulado : undefined,
    })) as any as MovimientoContable[];
  }
}
