import type { ISaldoContableRepository } from '../../application/abstractions/ISaldoContableRepository.js';
import type { ISaldoContablePeriodoRepository } from '../../application/abstractions/ISaldoContablePeriodoRepository.js';
import type { MovimientoContableEvent } from '../../application/contracts/MovimientoContableEvent.js';
import pino from 'pino';
import { prisma } from '../../infrastructure/persistence/PrismaService.js';
import type { IProcessedEventRepository } from '../../application/abstractions/IProcessedEventRepository.js';
import { createHash } from 'node:crypto';

type Key9D = {
  PeriodoId: number;
  CuentaContableId?: number;
  TerceroId?: number;
  CentroCostoId?: number;
  LibroContableId?: number;
  UnidadNegocioId?: number;
  CentroOperacionId?: number;
  CategorizacionId?: number;
  ModeloCarteraId?: number;
};

type Delta = { Debito: number; Credito: number };

export class MessageProcessor {
  constructor(
    private readonly saldoRepo: ISaldoContableRepository,
    private readonly saldoPeriodoRepo: ISaldoContablePeriodoRepository,
    private readonly logger: pino.Logger,
    private readonly processedEventRepo?: IProcessedEventRepository,
    private readonly idempotencyEnabled: boolean = false,
  ) {}

  async process(event: MovimientoContableEvent, _batchSize: number): Promise<void> {
    const movimientoId = event.id;
    const estado = event.Estado;
    const periodoInicioId = event.PeriodoId;

    this.logger.info({ movimientoId, estado, periodoId: periodoInicioId, correlationId: (event as any).CorrelationId }, '[RABBITMQ] Procesando evento (incremental)');

    const periodosObjetos = await this.saldoPeriodoRepo.getPeriodosDesdeIdOrdenados(periodoInicioId);
    if (periodosObjetos.length === 0) {
      this.logger.info({ movimientoId, periodoInicioId }, '[RABBITMQ] No hay periodos desde el periodo indicado, omitiendo');
      return;
    }
    const periodos = periodosObjetos.map((p) => p.id);

    const deltasByKey = this.buildDeltasByKey(event);

    // Cache de finales por periodo para propagar rápidos
    const finalesPorPeriodo = new Map<string, { SaldoFinalDebito: number; SaldoFinalCredito: number }>();

    const runCore = async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      for (let i = 0; i < periodos.length; i++) {
        const periodoId = periodos[i]!;
        const priorPeriodoId = i > 0 ? periodos[i - 1]! : null;

        for (const [keyStr, delta] of deltasByKey) {
          const key = this.parseKeyStr(keyStr, periodoId);

          // Determinar saldos iniciales
          let saldoInicialDebito = 0;
          let saldoInicialCredito = 0;

          if (i === 0) {
            // p0: conservar inicial si existe, sino traer de p-1
            const current = await this.saldoRepo.getByKey(key, tx);
            if (current) {
              saldoInicialDebito = current.saldoInicialDebito ?? 0;
              saldoInicialCredito = current.saldoInicialCredito ?? 0;
            } else if (priorPeriodoId !== null) {
              const priorKey = { ...key, PeriodoId: priorPeriodoId } satisfies Key9D;
              const prior = await this.saldoRepo.getByKey(priorKey, tx);
              saldoInicialDebito = prior?.saldoFinalDebito ?? 0;
              saldoInicialCredito = prior?.saldoFinalCredito ?? 0;
            }
          } else {
            // pi>0: inicial = final del periodo anterior post-ajuste
            const prevKeyStr = this.keyStr({ ...key, PeriodoId: priorPeriodoId! });
            const prev = finalesPorPeriodo.get(prevKeyStr);
            saldoInicialDebito = prev?.SaldoFinalDebito ?? 0;
            saldoInicialCredito = prev?.SaldoFinalCredito ?? 0;
          }

          // Cargar acumulados actuales del periodo (por si existe)
          const existing = await this.saldoRepo.getByKey(key, tx);
          const debitoActual = existing?.debito ?? 0;
          const creditoActual = existing?.credito ?? 0;

          const applyDelta = i === 0; // Solo en p0
          const debitoNuevo = applyDelta ? debitoActual + delta.Debito : debitoActual;
          const creditoNuevo = applyDelta ? creditoActual + delta.Credito : creditoActual;

          const saldoFinalDebito = saldoInicialDebito + debitoNuevo;
          const saldoFinalCredito = saldoInicialCredito + creditoNuevo;

          const values: any = {
            SaldoInicialDebito: saldoInicialDebito,
            SaldoInicialCredito: saldoInicialCredito,
            SaldoFinalDebito: saldoFinalDebito,
            SaldoFinalCredito: saldoFinalCredito,
          };
          if (applyDelta) {
            values.Debito = debitoNuevo;
            values.Credito = creditoNuevo;
          }
          await this.saldoRepo.updateByKey(key, values, tx);

          // Guardar finales para usar como inicial en el siguiente periodo
          finalesPorPeriodo.set(this.keyStr(key), {
            SaldoFinalDebito: saldoFinalDebito,
            SaldoFinalCredito: saldoFinalCredito,
          });
        }

        this.logger.info({ movimientoId, periodoProcesado: periodoId, claves: deltasByKey.size }, '[RABBITMQ] Periodo actualizado');
      }
    };

    if (this.idempotencyEnabled && this.processedEventRepo) {
      const payloadHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      try {
        await prisma.$transaction(async (tx) => {
          // Intentar marcar como en procesamiento (idempotencia)
          await this.processedEventRepo!.createProcessing(tx, {
            correlationId: (event as any).CorrelationId,
            movimientoId: event.id,
            periodoId: event.PeriodoId,
            payloadHash,
          });

          await runCore(tx);

          await this.processedEventRepo!.markCompleted(tx, (event as any).CorrelationId);
        });
      } catch (err: any) {
        // P2002: unique violation -> duplicado, considerado procesado previamente
        if (err?.code === 'P2002') {
          this.logger.info({ correlationId: (event as any).CorrelationId }, '[RABBITMQ] Evento duplicado, ACK sin reprocesar');
          return;
        }
        throw err;
      }
    } else {
      // Sin idempotencia, ejecutar en una transacción para evitar parciales
      await prisma.$transaction(async (tx) => {
        await runCore(tx);
      });
    }

    this.logger.info({ movimientoId, periodosProcesados: periodos.length, claves: deltasByKey.size }, '[RABBITMQ] Evento procesado');
  }

  private buildDeltasByKey(event: MovimientoContableEvent): Map<string, Delta> {
    const sign = event.Estado === 'Borrado' ? -1 : 1;
    const map = new Map<string, Delta>();
    for (const c of event.cuentas) {
      const keyStr = this.keyStr({
        PeriodoId: event.PeriodoId,
        CuentaContableId: c.CuentaContableId,
        TerceroId: c.TerceroId ?? undefined,
        CentroCostoId: c.CentroCostoId ?? undefined,
        LibroContableId: c.LibroContableId ?? undefined,
        UnidadNegocioId: c.UnidadNegocioId ?? undefined,
        CentroOperacionId: c.CentroOperacionId ?? undefined,
        CategorizacionId: c.CategorizacionId ?? undefined,
        ModeloCarteraId: c.ModeloCarteraId ?? undefined,
      });
      const prev = map.get(keyStr) ?? { Debito: 0, Credito: 0 };
      prev.Debito += sign * (c.Debito ?? 0);
      prev.Credito += sign * (c.Credito ?? 0);
      map.set(keyStr, prev);
    }
    return map;
  }

  private keyStr(key: Key9D): string {
    return [
      key.PeriodoId,
      key.TerceroId ?? 'null',
      key.CuentaContableId ?? 'null',
      key.CentroCostoId ?? 'null',
      key.LibroContableId ?? 'null',
      key.UnidadNegocioId ?? 'null',
      key.CentroOperacionId ?? 'null',
      key.CategorizacionId ?? 'null',
      key.ModeloCarteraId ?? 'null',
    ].join('|');
  }

  private parseKeyStr(keyStr: string, periodoId: number): Key9D {
    const [_, tercero, cuenta, centro, libro, unidad, oper, categ, modelo] = keyStr.split('|');
    return {
      PeriodoId: periodoId,
      TerceroId: tercero !== 'null' ? Number(tercero) : undefined,
      CuentaContableId: cuenta !== 'null' ? Number(cuenta) : undefined,
      CentroCostoId: centro !== 'null' ? Number(centro) : undefined,
      LibroContableId: libro !== 'null' ? Number(libro) : undefined,
      UnidadNegocioId: unidad !== 'null' ? Number(unidad) : undefined,
      CentroOperacionId: oper !== 'null' ? Number(oper) : undefined,
      CategorizacionId: categ !== 'null' ? Number(categ) : undefined,
      ModeloCarteraId: modelo !== 'null' ? Number(modelo) : undefined,
    };
  }
}
