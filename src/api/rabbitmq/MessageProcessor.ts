import type { IMovimientoContableRepository } from '../../application/abstractions/IMovimientoContableRepository.js';
import type { ISaldoContableRepository } from '../../application/abstractions/ISaldoContableRepository.js';
import type { ISaldoContablePeriodoRepository } from '../../application/abstractions/ISaldoContablePeriodoRepository.js';
import type { SaldoContable } from '../../domain/entities/SaldoContable.js';
import type { MovimientoContableCuentaAgrupadaRow } from '../../application/contracts/MovimientoContableCuentaAgrupadaRow.js';
import type { MovimientoContableEvent } from '../../application/contracts/MovimientoContableEvent.js';
import pino from 'pino';

const MIN_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10000;

export class MessageProcessor {
  constructor(
    private readonly movimientoRepo: IMovimientoContableRepository,
    private readonly saldoRepo: ISaldoContableRepository,
    private readonly saldoPeriodoRepo: ISaldoContablePeriodoRepository,
    private readonly logger: pino.Logger,
  ) {}

  async process(event: MovimientoContableEvent, batchSize: number): Promise<void> {
    const movimientoId = event.id;
    const estado = event.Estado;
    const fecha = event.fecha;

    this.logger.info({ movimientoId, estado, fecha }, '[RABBITMQ] Procesando evento de movimiento');

    const effectiveBatchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, batchSize));

    // Normalize to local date boundary; repositories are expected to normalize to UTC internally
    const periodoId = await this.movimientoRepo.getPeriodoPorFecha(
      new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()),
    );
    if (periodoId === null) {
      this.logger.warn({ movimientoId, fecha }, '[RABBITMQ] No se encontró periodo para la fecha del movimiento, omitiendo');
      return;
    }

    this.logger.info({ movimientoId, periodoId }, '[RABBITMQ] Periodo del movimiento determinado');

    const periodosObjetos = await this.saldoPeriodoRepo.getPeriodosDesdeFechaOrdenados(
      new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()),
    );
    if (periodosObjetos.length === 0) {
      this.logger.info({ movimientoId }, '[RABBITMQ] No hay periodos desde la fecha del movimiento, omitiendo recálculo');
      return;
    }

    const periodos = periodosObjetos.map((p) => p.id);
    const priorPeriodById = this.buildPriorPeriodMap(periodos);

    let priorSaldosForNextPeriod: SaldoContable[] | null = null;
    for (let i = 0; i < periodos.length; i++) {
      const periodoIdActual = periodos[i]!;
      const isFirst = i === 0;
      const { previousSaldos } = await this.recalcularPeriodo(
        periodoIdActual,
        effectiveBatchSize,
        priorPeriodById.get(periodoIdActual) ?? null,
        estado,
        isFirst ? event : undefined,
        priorSaldosForNextPeriod,
      );
      // Pass along the saldos previos (antes de reset) como base del siguiente periodo
      priorSaldosForNextPeriod = previousSaldos;
      this.logger.info({ movimientoId, periodoProcesado: periodoIdActual }, '[RABBITMQ] Periodo recalcificado');
    }

    this.logger.info({ movimientoId, periodosProcesados: periodos.length }, '[RABBITMQ] Evento de movimiento procesado completamente');
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

  private async recalcularPeriodo(
    periodoId: number,
    batchSize: number,
    priorPeriodId: number | null,
    estado: 'Creado' | 'Borrado',
    eventForThisPeriod?: MovimientoContableEvent,
    priorSaldosFromMemory?: SaldoContable[] | null,
  ): Promise<{ previousSaldos: SaldoContable[] }> {
    const { saldos: saldosDelPeriodo, previousSaldos } = await this.zeroInitializePeriod(periodoId);
    this.logger.info({ periodoId }, '[RABBITMQ] Saldos del periodo inicializados');

    const saldosByKey = new Map<string, SaldoContable>();
    for (const saldo of saldosDelPeriodo) {
      saldosByKey.set(
        this.buildSaldoKey(
          periodoId,
          saldo.terceroId,
          saldo.cuentaContableId,
          saldo.centroCostoId,
          saldo.libroContableId,
          saldo.unidadNegocioId,
          saldo.centroOperacionId,
          saldo.categorizacionId,
          saldo.modeloCarteraId,
        ),
        saldo,
      );
    }

    let lastId: number | undefined;
    let totalPeriodCuentas = 0;

    do {
      const batch = await this.movimientoRepo.getBatchByPeriodo(periodoId, batchSize, lastId);
      if (batch.length === 0) break;

      const movimientoIds = batch.map((m) => Number(m.id));
      // Excluir el movimiento sólo cuando es un borrado; en creado se debe incluir
      if (eventForThisPeriod && estado === 'Borrado') {
        const idx = movimientoIds.indexOf(eventForThisPeriod.id);
        if (idx !== -1) movimientoIds.splice(idx, 1);
      }

      if (movimientoIds.length === 0) {
        lastId = batch.at(-1)!.id;
        continue;
      }

      const cuentasAgrupadas = await this.movimientoRepo.getCuentasAgrupadasPorMovimientos(movimientoIds);

      for (const cuenta of cuentasAgrupadas) {
        const saldoKey = this.buildSaldoKey(
          periodoId,
          cuenta.TerceroId,
          cuenta.CuentaContableId,
          cuenta.CentroCostoId,
          cuenta.LibroContableId,
          cuenta.UnidadNegocioId,
          cuenta.CentroOperacionId,
          cuenta.CategorizacionId,
          cuenta.ModeloCarteraId,
        );
        let saldo = saldosByKey.get(saldoKey);

        if (!saldo) {
          saldo = this.createEmptySaldo(periodoId, cuenta);
          saldosByKey.set(saldoKey, saldo);
        }
        // Siempre sumamos la agregación del periodo (ya excluye el movimiento borrado si corresponde)
        saldo.debito += cuenta.Debito;
        saldo.credito += cuenta.Credito;
        totalPeriodCuentas++;
      }

      lastId = batch.at(-1)!.id;
    } while (true);

    // Ajuste directo por evento (solo aplica al periodo del evento)
    if (eventForThisPeriod && Array.isArray(eventForThisPeriod.cuentas) && eventForThisPeriod.cuentas.length > 0) {
      if (estado === 'Borrado') {
        for (const cuenta of eventForThisPeriod.cuentas) {
          // Solo aplicar si corresponde al periodo actual
          if (cuenta.PeriodoId && Number(cuenta.PeriodoId) !== Number(periodoId)) continue;
          const saldoKey = this.buildSaldoKey(
            periodoId,
            cuenta.TerceroId,
            cuenta.CuentaContableId,
            cuenta.CentroCostoId,
            cuenta.LibroContableId,
            cuenta.UnidadNegocioId,
            cuenta.CentroOperacionId,
            cuenta.CategorizacionId,
            cuenta.ModeloCarteraId,
          );
          let saldo = saldosByKey.get(saldoKey);
          if (!saldo) {
            // Crear saldo vacío compatible con MovimientoContableCuentaAgrupadaRow
            saldo = this.createEmptySaldo(periodoId, cuenta as unknown as MovimientoContableCuentaAgrupadaRow);
            saldosByKey.set(saldoKey, saldo);
          }
          // Restar el impacto del movimiento borrado
          saldo.debito -= cuenta.Debito ?? 0;
          saldo.credito -= cuenta.Credito ?? 0;
        }
      }
    }

    const saldosActualizados = Array.from(saldosByKey.values());
    await this.computePeriodSaldos(periodoId, saldosActualizados, priorPeriodId, priorSaldosFromMemory ?? null);
    this.logger.info({ periodoId, saldosActualizados: saldosActualizados.length }, '[RABBITMQ] Cálculo de saldos finalizado');
    return { previousSaldos: previousSaldos };
  }

  private async zeroInitializePeriod(
    periodoId: number,
  ): Promise<{ saldos: SaldoContable[]; resetCount: number; previousSaldos: SaldoContable[] }> {
    const saldos = await this.saldoRepo.getByPeriodo(periodoId);
    // Clonar una instantánea previa al reset para usar como referencia del siguiente periodo
    const previousSaldos: SaldoContable[] = saldos.map((s) => ({ ...s }));

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

    return { saldos, resetCount: saldos.length, previousSaldos };
  }

  private async computePeriodSaldos(
    periodoId: number,
    saldos: SaldoContable[],
    priorPeriodId: number | null,
    priorSaldosFromMemory: SaldoContable[] | null,
  ): Promise<void> {
    if (saldos.length === 0) return;

    const priorSaldosByKey = await this.buildPriorSaldosByKey(priorPeriodId, priorSaldosFromMemory);

    for (const saldo of saldos) {
      const priorSaldo = priorPeriodId === null
        ? undefined
        : priorSaldosByKey.get(
            this.buildSaldoKey(
              priorPeriodId,
              saldo.terceroId,
              saldo.cuentaContableId,
              saldo.centroCostoId,
              saldo.libroContableId,
              saldo.unidadNegocioId,
              saldo.centroOperacionId,
              saldo.categorizacionId,
              saldo.modeloCarteraId,
            ),
          );

      const saldoInicialDebito = priorSaldo?.saldoFinalDebito ?? 0;
      const saldoInicialCredito = priorSaldo?.saldoFinalCredito ?? 0;
      const saldoFinalDebito = saldoInicialDebito + saldo.debito;
      const saldoFinalCredito = saldoInicialCredito + saldo.credito;

      await this.saldoRepo.updateByKey(
        {
          PeriodoId: periodoId,
          TerceroId: saldo.terceroId,
          CuentaContableId: saldo.cuentaContableId,
          CentroCostoId: saldo.centroCostoId,
          LibroContableId: saldo.libroContableId,
          UnidadNegocioId: saldo.unidadNegocioId,
          CentroOperacionId: saldo.centroOperacionId,
          CategorizacionId: saldo.categorizacionId,
          ModeloCarteraId: saldo.modeloCarteraId,
        },
        {
          SaldoInicialDebito: saldoInicialDebito,
          SaldoInicialCredito: saldoInicialCredito,
          Debito: saldo.debito,
          Credito: saldo.credito,
          SaldoFinalDebito: saldoFinalDebito,
          SaldoFinalCredito: saldoFinalCredito,
        },
      );
    }
  }

  private async buildPriorSaldosByKey(
    priorPeriodId: number | null,
    priorSaldosFromMemory: SaldoContable[] | null,
  ): Promise<Map<string, SaldoContable>> {
    const priorSaldosByKey = new Map<string, SaldoContable>();
    if (priorPeriodId === null) return priorSaldosByKey;
    const priorSaldos = Array.isArray(priorSaldosFromMemory)
      ? priorSaldosFromMemory
      : await this.saldoRepo.getByPeriodo(priorPeriodId);
    for (const priorSaldo of priorSaldos) {
      priorSaldosByKey.set(
        this.buildSaldoKey(
          priorPeriodId,
          priorSaldo.terceroId,
          priorSaldo.cuentaContableId,
          priorSaldo.centroCostoId,
          priorSaldo.libroContableId,
          priorSaldo.unidadNegocioId,
          priorSaldo.centroOperacionId,
          priorSaldo.categorizacionId,
          priorSaldo.modeloCarteraId,
        ),
        priorSaldo,
      );
    }

    return priorSaldosByKey;
  }

  private buildSaldoKey(
    periodoId: number,
    terceroId?: number,
    cuentaContableId?: number,
    centroCostoId?: number,
    libroContableId?: number,
    unidadNegocioId?: number,
    centroOperacionId?: number,
    categorizacionId?: number,
    modeloCarteraId?: number,
  ): string {
    return [
      periodoId,
      terceroId ?? 'null',
      cuentaContableId ?? 'null',
      centroCostoId ?? 'null',
      libroContableId ?? 'null',
      unidadNegocioId ?? 'null',
      centroOperacionId ?? 'null',
      categorizacionId ?? 'null',
      modeloCarteraId ?? 'null',
    ].join('|');
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
}
