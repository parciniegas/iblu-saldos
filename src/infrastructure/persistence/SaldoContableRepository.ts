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
    const where: Prisma.SaldoContableWhereInput = this.buildWhereFromKey(key);
    const saldo = await prisma.saldoContable.findFirst({ where: where });

    if (!saldo) return null;

    return this.toDomain(saldo);
  }

  async copyFromPeriodo(prevPeriodoId: number, newPeriodoId: number): Promise<number> {
    // Inserta saldos del periodo anterior con saldos iniciales = finales previos y debito/credito en 0
    let affected = await prisma.$executeRaw`
      INSERT INTO saldos_contables (
        periodo_id,
        class,
        entidad_id,
        tercero_id,
        cuentacontable_id,
        centrocosto_id,
        saldoinicialdebito,
        saldoinicialcredito,
        debito,
        credito,
        saldofinaldebito,
        saldofinalcredito,
        created_at,
        updated_at,
        librocontable_id,
        unidadnegocio_id,
        centrooperacion_id,
        categorizacion_id,
        cierre,
        modelocartera_id,
        modelocartera,
        conceptotributario_id
      )
      SELECT
        ${newPeriodoId} as periodo_id,
        class,
        entidad_id,
        tercero_id,
        cuentacontable_id,
        centrocosto_id,
        saldofinaldebito as saldoinicialdebito,
        saldofinalcredito as saldoinicialcredito,
        0 as debito,
        0 as credito,
        saldofinaldebito,
        saldofinalcredito,
        NOW() as created_at,
        NOW() as updated_at,
        librocontable_id,
        unidadnegocio_id,
        centrooperacion_id,
        categorizacion_id,
        false as cierre,
        modelocartera_id,
        modelocartera,
        conceptotributario_id
      FROM saldos_contables
      WHERE periodo_id = ${prevPeriodoId}
    `;
    // Fallback: si no insertó nada pero el periodo anterior tiene saldos, realizar copia programática
    const inserted = Number(affected ?? 0);
    if (inserted > 0) return inserted;

    const prevCount = await prisma.saldoContable.count({ where: { periodoId: prevPeriodoId } });
    if (prevCount === 0) return 0;

    const prevRows = await prisma.saldoContable.findMany({ where: { periodoId: prevPeriodoId } });
    if (prevRows.length === 0) return 0;

    const mapped = prevRows.map((s): Prisma.SaldoContableCreateManyInput => ({
      periodoId: newPeriodoId,
      class: s.class,
      entidadId: s.entidadId,
      terceroId: s.terceroId,
      cuentaContableId: s.cuentaContableId,
      centroCostoId: s.centroCostoId,
      saldoInicialDebito: s.saldoFinalDebito as unknown as number,
      saldoInicialCredito: s.saldoFinalCredito as unknown as number,
      debito: 0 as unknown as number,
      credito: 0 as unknown as number,
      saldoFinalDebito: s.saldoFinalDebito as unknown as number,
      saldoFinalCredito: s.saldoFinalCredito as unknown as number,
      libroContableId: s.libroContableId,
      unidadNegocioId: s.unidadNegocioId,
      centroOperacionId: s.centroOperacionId,
      categorizacionId: s.categorizacionId,
      cierre: false,
      modeloCarteraId: s.modeloCarteraId,
      modeloCartera: s.modeloCartera,
      conceptoTributarioId: s.conceptoTributarioId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const batch = await prisma.saldoContable.createMany({ data: mapped });
    return Number(batch.count ?? mapped.length);
  }

  async countByPeriodo(periodoId: number): Promise<number> {
    const count = await prisma.saldoContable.count({ where: { periodoId } });
    return Number(count);
  }

  async updateByKey(key: SaldoContableKey, values: SaldoContableUpdateValues): Promise<void> {
    const where: Prisma.SaldoContableWhereInput = this.buildWhereFromKey(key);

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (values.SaldoInicialDebito !== undefined) updateData.saldoInicialDebito = values.SaldoInicialDebito;
    if (values.SaldoInicialCredito !== undefined) updateData.saldoInicialCredito = values.SaldoInicialCredito;
    if (values.Debito !== undefined) updateData.debito = values.Debito;
    if (values.Credito !== undefined) updateData.credito = values.Credito;
    if (values.SaldoFinalDebito !== undefined) updateData.saldoFinalDebito = values.SaldoFinalDebito;
    if (values.SaldoFinalCredito !== undefined) updateData.saldoFinalCredito = values.SaldoFinalCredito;
    if (values.Cierre !== undefined) updateData.cierre = values.Cierre;

    const result = await prisma.saldoContable.updateMany({ where, data: updateData });
    if ((result?.count ?? 0) === 0) {
      // Upsert: crear si no existe exactamente ese saldo
      await prisma.saldoContable.create({
        data: {
          periodoId: key.PeriodoId,
          terceroId: key.TerceroId ?? null,
          cuentaContableId: key.CuentaContableId ?? null,
          centroCostoId: key.CentroCostoId ?? null,
          libroContableId: key.LibroContableId ?? null,
          unidadNegocioId: key.UnidadNegocioId ?? null,
          centroOperacionId: key.CentroOperacionId ?? null,
          categorizacionId: key.CategorizacionId ?? null,
          modeloCarteraId: key.ModeloCarteraId ?? null,
          saldoInicialDebito: values.SaldoInicialDebito ?? 0,
          saldoInicialCredito: values.SaldoInicialCredito ?? 0,
          debito: values.Debito ?? 0,
          credito: values.Credito ?? 0,
          saldoFinalDebito: values.SaldoFinalDebito ?? (values.SaldoInicialDebito ?? 0) + (values.Debito ?? 0),
          saldoFinalCredito: values.SaldoFinalCredito ?? (values.SaldoInicialCredito ?? 0) + (values.Credito ?? 0),
          cierre: values.Cierre ?? false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
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

  private buildWhereFromKey(key: SaldoContableKey): Prisma.SaldoContableWhereInput {
    // Igualdad exacta en 9 dimensiones; undefined => null explícito
    return {
      periodoId: key.PeriodoId,
      cuentaContableId: key.CuentaContableId ?? null,
      terceroId: key.TerceroId ?? null,
      centroCostoId: key.CentroCostoId ?? null,
      libroContableId: key.LibroContableId ?? null,
      unidadNegocioId: key.UnidadNegocioId ?? null,
      centroOperacionId: key.CentroOperacionId ?? null,
      categorizacionId: key.CategorizacionId ?? null,
      modeloCarteraId: key.ModeloCarteraId ?? null,
    } as Prisma.SaldoContableWhereInput;
  }
}
