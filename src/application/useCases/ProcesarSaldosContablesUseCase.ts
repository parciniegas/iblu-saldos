import type { IMovimientoContableRepository } from '../abstractions/IMovimientoContableRepository.js';
import type { ISaldoContableRepository } from '../abstractions/ISaldoContableRepository.js';
import type { SaldoContableKey } from '../contracts/SaldoContableKey.js';
import type { SaldoContable } from '../../domain/entities/SaldoContable.js';
import type { MovimientoContableCuentaAgrupadaRow } from '../contracts/MovimientoContableCuentaAgrupadaRow.js';
import pino from 'pino';

export type JobResult = {
  jobId: string;
  status: 'completed' | 'failed';
  fechaDesde: string;
  batchSize: number;
  periodosProcesados: number;
  movimientosProcesados: number;
  movimientosCuentaProcesados: number;
  tiempoTotalMs: number;
  eta?: string;
  error?: string;
};

const MIN_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10000;

type PeriodProcessingResult = {
  totalPeriodMovimientos: number;
  totalPeriodCuentas: number;
};

type SaldoUpdatePayload = {
  key: SaldoContableKey;
  values: {
    SaldoInicialDebito: number;
    SaldoInicialCredito: number;
    Debito: number;
    Credito: number;
    SaldoFinalDebito: number;
    SaldoFinalCredito: number;
  };
};

export class ProcesarSaldosContablesUseCase {
  constructor(
    private readonly movimientoRepo: IMovimientoContableRepository,
    private readonly saldoRepo: ISaldoContableRepository,
    private readonly logger: pino.Logger,
  ) {}

  async execute(
    fechaDesde: string,
    batchSize: number,
    jobId: string,
  ): Promise<JobResult> {
    const inicio = Date.now();
    const fechaDesdeDate = new Date(fechaDesde + 'T00:00:00');
    const effectiveBatchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, batchSize));

    this.logger.info({ jobId, fechaDesde, effectiveBatchSize }, '[SALDOS] Iniciando procesamiento');

    let totalMovimientosProcesados = 0;
    let totalMovimientosCuentaProcesados = 0;
    let periodosProcesados = 0;

    try {
      const periodos = await this.movimientoRepo.getPeriodosDesdeFecha(fechaDesdeDate);
      this.logger.info({ jobId, periodosCount: periodos.length }, '[SALDOS] Periodos encontrados');
      const priorPeriodById = this.buildPriorPeriodMap(periodos);

      let periodTimesTotal = 0;

      for (const periodoId of periodos) {
        const periodoStart = Date.now();
        const { totalPeriodMovimientos, totalPeriodCuentas } = await this.processPeriodo(
          periodoId,
          effectiveBatchSize,
          priorPeriodById.get(periodoId) ?? null,
        );

        const periodoTiempo = Date.now() - periodoStart;
        periodTimesTotal += periodoTiempo;
        periodosProcesados++;
        totalMovimientosProcesados += totalPeriodMovimientos;
        totalMovimientosCuentaProcesados += totalPeriodCuentas;

        const promedioMs = periodTimesTotal / periodosProcesados;
        const periodosRestantes = periodos.length - periodosProcesados;
        const etaMs = periodosRestantes * promedioMs;
        const eta = this.formatMs(etaMs);

        this.logger.info({
          jobId,
          periodoId,
          movimientosProcesados: totalPeriodMovimientos,
          cuentasProcesadas: totalPeriodCuentas,
          tiempoMs: periodoTiempo,
          promedioMs: Math.round(promedioMs),
          eta,
        }, `[SALDOS] Periodo ${periodoId} completado`);
      }

      const tiempoTotal = Date.now() - inicio;
      const promedioMsPorPeriodo = periodos.length > 0 ? tiempoTotal / periodos.length : 0;
      const periodosRestantesFinal = periodos.length - periodosProcesados;
      const eta = periodosRestantesFinal > 1 ? this.formatMs(periodosRestantesFinal * promedioMsPorPeriodo) : undefined;

      this.logger.info({
        jobId,
        periodosProcesados,
        movimientosProcesados: totalMovimientosProcesados,
        movimientosCuentaProcesados: totalMovimientosCuentaProcesados,
        tiempoTotalMs: tiempoTotal,
        eta,
      }, '[SALDOS] Procesamiento completado');

      return {
        jobId,
        status: 'completed',
        fechaDesde,
        batchSize: effectiveBatchSize,
        periodosProcesados,
        movimientosProcesados: totalMovimientosProcesados,
        movimientosCuentaProcesados: totalMovimientosCuentaProcesados,
        tiempoTotalMs: tiempoTotal,
        eta,
      };
    } catch (error) {
      const tiempoTotal = Date.now() - inicio;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error({ jobId, error: errorMessage, tiempoTotalMs: tiempoTotal }, '[SALDOS] Error en procesamiento');

      return {
        jobId,
        status: 'failed',
        fechaDesde,
        batchSize: effectiveBatchSize,
        periodosProcesados: periodosProcesados,
        movimientosProcesados: totalMovimientosProcesados,
        movimientosCuentaProcesados: totalMovimientosCuentaProcesados,
        tiempoTotalMs: tiempoTotal,
        error: errorMessage,
      };
    }
  }

  private buildPriorPeriodMap(periodos: number[]): Map<number, number | null> {
    const priorPeriodById = new Map<number, number | null>();

    for (let i = 0; i < periodos.length; i++) {
      const current = periodos[i];
      if (current === undefined) continue;
      priorPeriodById.set(current, i > 0 ? periodos[i - 1] ?? null : null);
    }

    return priorPeriodById;
  }

  private async processPeriodo(
    periodoId: number,
    batchSize: number,
    priorPeriodId: number | null,
  ): Promise<PeriodProcessingResult> {
    const saldosDelPeriodo = await this.zeroInitializePeriod(periodoId, batchSize);
    const saldosByKey = new Map<string, SaldoContable>();

    for (const saldo of saldosDelPeriodo) {
      saldosByKey.set(
        this.buildSaldoKey(periodoId, saldo.terceroId, saldo.cuentaContableId, saldo.centroCostoId),
        saldo,
      );
    }

    let lastId: number | undefined;
    let batch: Awaited<ReturnType<IMovimientoContableRepository['getBatchByPeriodo']>>;
    let totalPeriodMovimientos = 0;
    let totalPeriodCuentas = 0;

    do {
      batch = await this.movimientoRepo.getBatchByPeriodo(periodoId, batchSize, lastId);
      if (batch.length === 0) break;

      this.logger.debug({ periodoId, batchSize: batch.length, lastId }, '[SALDOS] Batch obtenido');

      const movimientoIds = batch.map((m) => m.id);
      const cuentasAgrupadas = await this.movimientoRepo.getCuentasAgrupadasPorMovimientos(movimientoIds);

      this.logger.debug({ periodoId, cuentasAgrupadas: cuentasAgrupadas.length }, '[SALDOS] Cuentas agrupadas procesadas');

      for (const cuenta of cuentasAgrupadas) {
        const saldoKey = this.buildSaldoKey(
          periodoId,
          cuenta.TerceroId,
          cuenta.CuentaContableId,
          cuenta.CentroCostoId,
        );
        let saldo = saldosByKey.get(saldoKey);

        if (!saldo) {
          saldo = this.createEmptySaldo(periodoId, cuenta);
          saldosByKey.set(saldoKey, saldo);
        }

        saldo.debito += cuenta.Debito;
        saldo.credito += cuenta.Credito;
        totalPeriodCuentas++;
      }

      totalPeriodMovimientos += batch.length;
      lastId = batch.at(-1)!.id;
      
      this.logger.debug({ periodoId, totalPeriodMovimientos, totalPeriodCuentas }, '[SALDOS] Batch procesado completamente');
    } while (batch.length >= batchSize);

    const saldosActualizados = Array.from(saldosByKey.values());
    await this.computePeriodSaldos(periodoId, saldosActualizados, totalPeriodCuentas, priorPeriodId);

    return {
      totalPeriodMovimientos,
      totalPeriodCuentas,
    };
  }

  private async zeroInitializePeriod(periodoId: number, batchSize: number): Promise<SaldoContable[]> {
    const saldos = await this.saldoRepo.getByPeriodo(periodoId);
    this.logger.debug({ periodoId, totalSaldos: saldos.length, batchSize }, '[SALDOS] Iniciando zeroInitializePeriod');

    for (const saldo of saldos) {
      saldo.saldoInicialDebito = 0;
      saldo.saldoInicialCredito = 0;
      saldo.debito = 0;
      saldo.credito = 0;
      saldo.saldoFinalDebito = 0;
      saldo.saldoFinalCredito = 0;
    }

    if (saldos.length > 0) {
      await this.saldoRepo.bulkUpdate(saldos);
    }

    return saldos;
  }

  private async computePeriodSaldos(
    periodoId: number,
    saldos: SaldoContable[],
    cuentasProcesadas: number,
    priorPeriodId: number | null,
  ): Promise<void> {
    if (cuentasProcesadas === 0) return;

    this.logger.debug({ periodoId, cuentasProcesadas, saldosCount: saldos.length }, '[SALDOS] Iniciando computePeriodSaldos');

    const priorSaldosByKey = await this.buildPriorSaldosByKey(priorPeriodId);
    const pendingUpdates: SaldoUpdatePayload[] = [];
    const saldosByKey = new Map<string, SaldoContable>();

    for (const saldo of saldos) {
      saldosByKey.set(this.buildSaldoKey(periodoId, saldo.terceroId, saldo.cuentaContableId, saldo.centroCostoId), saldo);
    }

    for (let saldoIndex = 0; saldoIndex < saldos.length; saldoIndex++) {
      const saldo = saldos[saldoIndex];
      if (!saldo) continue;

      if (saldoIndex > 0 && saldoIndex % 1000 === 0) {
        this.logger.debug({ periodoId, procesados: saldoIndex, total: saldos.length }, '[SALDOS] computePeriodSaldos en progreso');
      }
      pendingUpdates.push(this.buildSaldoUpdate(periodoId, saldo, priorPeriodId, priorSaldosByKey));
    }

    for (const update of pendingUpdates) {
      const saldo = saldosByKey.get(this.buildSaldoKey(
        update.key.PeriodoId,
        update.key.TerceroId,
        update.key.CuentaContableId,
        update.key.CentroCostoId,
      ));
      if (!saldo) continue;

      saldo.saldoInicialDebito = update.values.SaldoInicialDebito;
      saldo.saldoInicialCredito = update.values.SaldoInicialCredito;
      saldo.debito = update.values.Debito;
      saldo.credito = update.values.Credito;
      saldo.saldoFinalDebito = update.values.SaldoFinalDebito;
      saldo.saldoFinalCredito = update.values.SaldoFinalCredito;
    }

    if (saldos.length > 0) {
      await this.saldoRepo.bulkUpdate(saldos);
    }
  }

  private async buildPriorSaldosByKey(priorPeriodId: number | null): Promise<Map<string, SaldoContable>> {
    const priorSaldosByKey = new Map<string, SaldoContable>();
    if (priorPeriodId === null) return priorSaldosByKey;

    const priorSaldos = await this.saldoRepo.getByPeriodo(priorPeriodId);
    for (const priorSaldo of priorSaldos) {
      priorSaldosByKey.set(
        this.buildSaldoKey(priorPeriodId, priorSaldo.terceroId, priorSaldo.cuentaContableId, priorSaldo.centroCostoId),
        priorSaldo,
      );
    }

    return priorSaldosByKey;
  }

  private buildSaldoUpdate(
    periodoId: number,
    saldo: SaldoContable,
    priorPeriodId: number | null,
    priorSaldosByKey: Map<string, SaldoContable>,
  ): SaldoUpdatePayload {
    const key: SaldoContableKey = {
      PeriodoId: periodoId,
      TerceroId: saldo.terceroId,
      CuentaContableId: saldo.cuentaContableId,
      CentroCostoId: saldo.centroCostoId,
    };

    const priorSaldo = priorPeriodId === null
      ? undefined
      : priorSaldosByKey.get(this.buildSaldoKey(
        priorPeriodId,
        saldo.terceroId,
        saldo.cuentaContableId,
        saldo.centroCostoId,
      ));

    const saldoInicialDebito = priorSaldo?.saldoFinalDebito ?? 0;
    const saldoInicialCredito = priorSaldo?.saldoFinalCredito ?? 0;
    const saldoFinalDebito = saldoInicialDebito + saldo.debito;
    const saldoFinalCredito = saldoInicialCredito + saldo.credito;

    return {
      key,
      values: {
        SaldoInicialDebito: saldoInicialDebito,
        SaldoInicialCredito: saldoInicialCredito,
        Debito: saldo.debito,
        Credito: saldo.credito,
        SaldoFinalDebito: saldoFinalDebito,
        SaldoFinalCredito: saldoFinalCredito,
      },
    };
  }

  private buildSaldoKey(periodoId: number, terceroId?: number, cuentaContableId?: number, centroCostoId?: number): string {
    return [periodoId, terceroId ?? 'null', cuentaContableId ?? 'null', centroCostoId ?? 'null'].join('|');
  }

  private createEmptySaldo(periodoId: number, cuenta: MovimientoContableCuentaAgrupadaRow): SaldoContable {
    return {
      id: 0,
      periodoId,
      class: cuenta.ModeloCartera || undefined,
      entidadId: undefined,
      terceroId: cuenta.TerceroId,
      cuentaContableId: cuenta.CuentaContableId,
      centroCostoId: cuenta.CentroCostoId,
      saldoInicialDebito: 0,
      saldoInicialCredito: 0,
      debito: 0,
      credito: 0,
      saldoFinalDebito: 0,
      saldoFinalCredito: 0,
      libroContableId: cuenta.LibroContableId,
      unidadNegocioId: cuenta.UnidadNegocioId,
      centroOperacionId: cuenta.CentroOperacionId,
      categorizacionId: cuenta.CategorizacionId,
      cierre: false,
      modeloCarteraId: cuenta.ModeloCarteraId,
      modeloCartera: cuenta.ModeloCartera,
      conceptoTributarioId: cuenta.ConceptoTributarioId,
    };
  }

  private formatMs(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}
