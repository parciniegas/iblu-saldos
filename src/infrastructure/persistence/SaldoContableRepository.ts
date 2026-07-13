import { prisma } from './PrismaService.js';
import type { ISaldoContableRepository } from '../../application/abstractions/ISaldoContableRepository.js';
import type { SaldoContableKey } from '../../application/contracts/SaldoContableKey.js';
import type { SaldoContableUpdateValues } from '../../application/contracts/SaldoContableUpdateValues.js';
import type { SaldoContable } from '../../domain/entities/SaldoContable.js';

export class SaldoContableRepository implements ISaldoContableRepository {
  async getByKey(key: SaldoContableKey): Promise<SaldoContable | null> {
    const where: { periodoId: number; terceroId?: number; cuentaContableId?: number; centroCostoId?: number } = {
      periodoId: key.PeriodoId,
    };

    if (key.TerceroId !== undefined) where.terceroId = key.TerceroId;
    if (key.CuentaContableId !== undefined) where.cuentaContableId = key.CuentaContableId;
    if (key.CentroCostoId !== undefined) where.centroCostoId = key.CentroCostoId;

    const saldo = await prisma.saldoContable.findFirst({ where });

    if (!saldo) return null;

    return this.toDomain(saldo);
  }

  async updateByKey(key: SaldoContableKey, values: SaldoContableUpdateValues): Promise<void> {
    const where: { periodoId: number; terceroId?: number; cuentaContableId?: number; centroCostoId?: number } = {
      periodoId: key.PeriodoId,
    };

    if (key.TerceroId !== undefined) where.terceroId = key.TerceroId;
    if (key.CuentaContableId !== undefined) where.cuentaContableId = key.CuentaContableId;
    if (key.CentroCostoId !== undefined) where.centroCostoId = key.CentroCostoId;

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (values.SaldoInicialDebito !== undefined) updateData.saldoInicialDebito = values.SaldoInicialDebito;
    if (values.SaldoInicialCredito !== undefined) updateData.saldoInicialCredito = values.SaldoInicialCredito;
    if (values.Debito !== undefined) updateData.debito = values.Debito;
    if (values.Credito !== undefined) updateData.credito = values.Credito;
    if (values.SaldoFinalDebito !== undefined) updateData.saldoFinalDebito = values.SaldoFinalDebito;
    if (values.SaldoFinalCredito !== undefined) updateData.saldoFinalCredito = values.SaldoFinalCredito;
    if (values.Cierre !== undefined) updateData.cierre = values.Cierre;

    await (prisma.saldoContable as any).update({ where, data: updateData });
  }

  async getByPeriodo(periodoId: number): Promise<SaldoContable[]> {
    const saldos = await prisma.saldoContable.findMany({
      where: { periodoId },
    });

    return saldos.map((s) => this.toDomain(s));
  }

  async bulkUpdate(saldos: SaldoContable[]): Promise<void> {
    const now = new Date();

    const creates = saldos.filter((s) => s.id === 0).map((saldo) => ({
      data: {
        periodoId: saldo.periodoId,
        class: saldo.class ?? undefined,
        entidadId: saldo.entidadId,
        terceroId: saldo.terceroId,
        cuentaContableId: saldo.cuentaContableId,
        centroCostoId: saldo.centroCostoId,
        saldoInicialDebito: saldo.saldoInicialDebito,
        saldoInicialCredito: saldo.saldoInicialCredito,
        debito: saldo.debito,
        credito: saldo.credito,
        saldoFinalDebito: saldo.saldoFinalDebito,
        saldoFinalCredito: saldo.saldoFinalCredito,
        libroContableId: saldo.libroContableId,
        unidadNegocioId: saldo.unidadNegocioId,
        centroOperacionId: saldo.centroOperacionId,
        categorizacionId: saldo.categorizacionId,
        cierre: saldo.cierre,
        modeloCarteraId: saldo.modeloCarteraId,
        modeloCartera: saldo.modeloCartera,
        conceptoTributarioId: saldo.conceptoTributarioId,
      },
    }));

    const updates = saldos.filter((s) => s.id !== 0).map((saldo) => ({
      where: { id: saldo.id },
      data: { updatedAt: now },
    }));

    const operations: any[] = [];
    for (const create of creates) {
      operations.push(prisma.saldoContable.create(create));
    }
    for (const update of updates) {
      operations.push(prisma.saldoContable.update(update));
    }

    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }
  }

  private toDomain(saldo: any): SaldoContable {
    return {
      id: Number(saldo.id),
      periodoId: Number(saldo.periodoId),
      class: saldo.class ?? undefined,
      entidadId: saldo.entidadId ?? undefined,
      terceroId: saldo.terceroId ?? undefined,
      cuentaContableId: saldo.cuentaContableId ?? undefined,
      centroCostoId: saldo.centroCostoId ?? undefined,
      saldoInicialDebito: Number(saldo.saldoInicialDebito),
      saldoInicialCredito: Number(saldo.saldoInicialCredito),
      debito: Number(saldo.debito),
      credito: Number(saldo.credito),
      saldoFinalDebito: Number(saldo.saldoFinalDebito),
      saldoFinalCredito: Number(saldo.saldoFinalCredito),
      createdAt: saldo.createdAt ?? undefined,
      updatedAt: saldo.updatedAt ?? undefined,
      libroContableId: saldo.libroContableId ?? undefined,
      unidadNegocioId: saldo.unidadNegocioId ?? undefined,
      centroOperacionId: saldo.centroOperacionId ?? undefined,
      categorizacionId: saldo.categorizacionId ?? undefined,
      cierre: saldo.cierre,
      modeloCarteraId: saldo.modeloCarteraId ?? undefined,
      modeloCartera: saldo.modeloCartera ?? undefined,
      conceptoTributarioId: saldo.conceptoTributarioId ?? undefined,
    };
  }
}
