import { prisma } from './PrismaService.js';
import { Prisma, type SaldoContable as PrismaSaldoContable } from '@prisma/client';
import type { ISaldoContableRepository } from '../../application/abstractions/ISaldoContableRepository.js';
import type { SaldoContableKey } from '../../application/contracts/SaldoContableKey.js';
import type { SaldoContableUpdateValues } from '../../application/contracts/SaldoContableUpdateValues.js';
import type { SaldoContable } from '../../domain/entities/SaldoContable.js';

const BULK_UPDATE_CHUNK_SIZE = 500;
const BULK_UPDATE_CHUNK_SIZE_ENV = 'SALDOS_BULK_UPDATE_CHUNK_SIZE';

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

    await prisma.saldoContable.updateMany({ where, data: updateData });
  }

  async getByPeriodo(periodoId: number): Promise<SaldoContable[]> {
    const saldos = await prisma.saldoContable.findMany({
      where: { periodoId },
    });

    return saldos.map((s) => this.toDomain(s));
  }

  async bulkUpdate(saldos: SaldoContable[]): Promise<void> {
    const now = new Date();

    const creates = saldos.filter((s) => s.id === 0).map((saldo): Prisma.SaldoContableCreateManyInput => ({
      periodoId: saldo.periodoId,
      class: saldo.class ?? null,
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
      createdAt: now,
      updatedAt: now,
    }));

    const existing = saldos.filter((s) => s.id !== 0);

    if (creates.length > 0) {
      await prisma.saldoContable.createMany({ data: creates });
    }

    if (existing.length > 0) {
      const chunkSize = this.getBulkUpdateChunkSize();
      for (let i = 0; i < existing.length; i += chunkSize) {
        const chunk = existing.slice(i, i + chunkSize);
        await this.bulkUpdateByIdChunk(chunk, now);
      }
    }
  }

  private getBulkUpdateChunkSize(): number {
    const value = Number.parseInt(process.env[BULK_UPDATE_CHUNK_SIZE_ENV] ?? '', 10);
    if (Number.isNaN(value) || value <= 0) return BULK_UPDATE_CHUNK_SIZE;
    return value;
  }

  private async bulkUpdateByIdChunk(saldos: SaldoContable[], now: Date): Promise<void> {
    const ids = saldos.map((saldo) => saldo.id);

    const saldoInicialDebitoCases = Prisma.join(
      saldos.map((saldo) => Prisma.sql`WHEN ${saldo.id} THEN ${saldo.saldoInicialDebito}`),
      ' ',
    );

    const saldoInicialCreditoCases = Prisma.join(
      saldos.map((saldo) => Prisma.sql`WHEN ${saldo.id} THEN ${saldo.saldoInicialCredito}`),
      ' ',
    );

    const debitoCases = Prisma.join(
      saldos.map((saldo) => Prisma.sql`WHEN ${saldo.id} THEN ${saldo.debito}`),
      ' ',
    );

    const creditoCases = Prisma.join(
      saldos.map((saldo) => Prisma.sql`WHEN ${saldo.id} THEN ${saldo.credito}`),
      ' ',
    );

    const saldoFinalDebitoCases = Prisma.join(
      saldos.map((saldo) => Prisma.sql`WHEN ${saldo.id} THEN ${saldo.saldoFinalDebito}`),
      ' ',
    );

    const saldoFinalCreditoCases = Prisma.join(
      saldos.map((saldo) => Prisma.sql`WHEN ${saldo.id} THEN ${saldo.saldoFinalCredito}`),
      ' ',
    );

    const cierreCases = Prisma.join(
      saldos.map((saldo) => Prisma.sql`WHEN ${saldo.id} THEN ${saldo.cierre}`),
      ' ',
    );

    await prisma.$executeRaw`
      UPDATE saldos_contables
      SET
        saldoinicialdebito = CASE id ${saldoInicialDebitoCases} ELSE saldoinicialdebito END,
        saldoinicialcredito = CASE id ${saldoInicialCreditoCases} ELSE saldoinicialcredito END,
        debito = CASE id ${debitoCases} ELSE debito END,
        credito = CASE id ${creditoCases} ELSE credito END,
        saldofinaldebito = CASE id ${saldoFinalDebitoCases} ELSE saldofinaldebito END,
        saldofinalcredito = CASE id ${saldoFinalCreditoCases} ELSE saldofinalcredito END,
        cierre = CASE id ${cierreCases} ELSE cierre END,
        updated_at = ${now}
      WHERE id IN (${Prisma.join(ids)})
    `;
  }

  private toDomain(saldo: PrismaSaldoContable): SaldoContable {
    return {
      id: Number(saldo.id),
      periodoId: Number(saldo.periodoId),
      class: undefined,
      entidadId: saldo.entidadId != null ? Number(saldo.entidadId) : undefined,
      terceroId: saldo.terceroId != null ? Number(saldo.terceroId) : undefined,
      cuentaContableId: saldo.cuentaContableId != null ? Number(saldo.cuentaContableId) : undefined,
      centroCostoId: saldo.centroCostoId != null ? Number(saldo.centroCostoId) : undefined,
      saldoInicialDebito: Number(saldo.saldoInicialDebito),
      saldoInicialCredito: Number(saldo.saldoInicialCredito),
      debito: Number(saldo.debito),
      credito: Number(saldo.credito),
      saldoFinalDebito: Number(saldo.saldoFinalDebito),
      saldoFinalCredito: Number(saldo.saldoFinalCredito),
      createdAt: undefined,
      updatedAt: saldo.updatedAt ?? undefined,
      libroContableId: saldo.libroContableId != null ? Number(saldo.libroContableId) : undefined,
      unidadNegocioId: saldo.unidadNegocioId != null ? Number(saldo.unidadNegocioId) : undefined,
      centroOperacionId: saldo.centroOperacionId != null ? Number(saldo.centroOperacionId) : undefined,
      categorizacionId: saldo.categorizacionId != null ? Number(saldo.categorizacionId) : undefined,
      cierre: saldo.cierre,
      modeloCarteraId: saldo.modeloCarteraId != null ? Number(saldo.modeloCarteraId) : undefined,
      modeloCartera: saldo.modeloCartera ?? undefined,
      conceptoTributarioId: saldo.conceptoTributarioId != null ? Number(saldo.conceptoTributarioId) : undefined,
    };
  }
}
