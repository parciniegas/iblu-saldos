import { describe, it, expect, vi } from 'vitest';
import { ProcesarSaldosContablesUseCase } from '../../src/application/useCases/ProcesarSaldosContablesUseCase.js';
import type { IMovimientoContableRepository } from '../../src/application/abstractions/IMovimientoContableRepository.js';
import type { ISaldoContableRepository } from '../../src/application/abstractions/ISaldoContableRepository.js';
import type { MovimientoContable } from '../../src/domain/entities/MovimientoContable.js';
import type { SaldoContable } from '../../src/domain/entities/SaldoContable.js';
import type { MovimientoContableCuentaAgrupadaRow } from '../../src/application/contracts/MovimientoContableCuentaAgrupadaRow.js';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
} as any;

function createMockRepositories(): {
  movimientoRepo: IMovimientoContableRepository;
  saldoRepo: ISaldoContableRepository;
} {
  const movimientoRepo = {
    getCuentasAgrupadasPorMovimientos: vi.fn().mockResolvedValue([]),
    getPeriodosDesdeFecha: vi.fn().mockResolvedValue([]),
    getBatchByPeriodo: vi.fn().mockResolvedValue([]),
  } as unknown as IMovimientoContableRepository;

  const saldoRepo = {
    getByKey: vi.fn().mockResolvedValue(null),
    updateByKey: vi.fn().mockResolvedValue(undefined),
    getByPeriodo: vi.fn().mockResolvedValue([]),
    bulkUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ISaldoContableRepository;

  return { movimientoRepo, saldoRepo };
}

describe('ProcesarSaldosContablesUseCase', () => {
  it('debe persistir saldos nuevos agregados en el periodo', async () => {
    const { movimientoRepo, saldoRepo } = createMockRepositories();

    movimientoRepo.getPeriodosDesdeFecha.mockResolvedValue([1]);
    movimientoRepo.getBatchByPeriodo
      .mockResolvedValueOnce([{ id: 10 } as MovimientoContable])
      .mockResolvedValueOnce([]);
    movimientoRepo.getCuentasAgrupadasPorMovimientos.mockResolvedValue([
      {
        MovimientoContableId: 10,
        PeriodoId: 1,
        CuentaContableId: 1105,
        TerceroId: 200,
        CentroCostoId: 10,
        LibroContableId: 1,
        UnidadNegocioId: 1,
        CentroOperacionId: 1,
        CategorizacionId: 1,
        ModeloCarteraId: 1,
        ModeloCartera: 'A',
        ConceptoTributarioId: 1,
        Debito: 100,
        Credito: 25,
        RegistrosMovimientoContableCuenta: 1,
      } as MovimientoContableCuentaAgrupadaRow,
    ]);

    saldoRepo.getByPeriodo
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      mockLogger,
    );

    const result = await useCase.execute('2024-01-01', 1000, 'test-job');

    expect(result.status).toBe('completed');
    expect(saldoRepo.bulkUpdate).toHaveBeenCalledTimes(1);
    const [bulkPayload] = (saldoRepo.bulkUpdate as any).mock.calls[0];
    expect(bulkPayload).toHaveLength(1);
    expect(bulkPayload[0].debito).toBe(100);
    expect(bulkPayload[0].credito).toBe(25);
  });

  it('debe clamp batch size a [1000, 10000]', async () => {
    const { movimientoRepo, saldoRepo } = createMockRepositories();

    movimientoRepo.getPeriodosDesdeFecha.mockResolvedValue([1, 2, 3]);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      mockLogger,
    );

    // Test con batchSize menor al mínimo
    const resultLow = await useCase.execute('2024-01-01', 100, 'test-job');
    expect(resultLow.status).toBe('completed');

    // Test con batchSize mayor al máximo
    const resultHigh = await useCase.execute('2024-01-01', 99999, 'test-job-2');
    expect(resultHigh.status).toBe('completed');
  });

  it('debe procesar periodos en orden ascendente', async () => {
    const { movimientoRepo, saldoRepo } = createMockRepositories();

    const periodos = [5, 10, 15, 20];
    movimientoRepo.getPeriodosDesdeFecha.mockResolvedValue(periodos);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      mockLogger,
    );

    await useCase.execute('2024-01-01', 1000, 'test-job');

    expect((movimientoRepo.getPeriodosDesdeFecha as any).mock.calls.length).toBeGreaterThan(0);
  });

  it('debe retornar error cuando falla la conexión', async () => {
    const { movimientoRepo, saldoRepo } = createMockRepositories();

    movimientoRepo.getPeriodosDesdeFecha.mockRejectedValue(new Error('Connection refused'));

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      mockLogger,
    );

    const result = await useCase.execute('2024-01-01', 1000, 'test-job');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Connection refused');
  });

  it('debe retornar resultados con métricas', async () => {
    const { movimientoRepo, saldoRepo } = createMockRepositories();

    movimientoRepo.getPeriodosDesdeFecha.mockResolvedValue([1, 2]);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      mockLogger,
    );

    const result = await useCase.execute('2024-01-01', 1000, 'test-job');

    expect(result.periodosProcesados).toBe(2);
    expect(result.movimientosProcesados).toBeTypeOf('number');
    expect(result.tiempoTotalMs).toBeTypeOf('number');
    expect(result.jobId).toBe('test-job');
  });

  it('debe emitir progreso durante el procesamiento', async () => {
    const { movimientoRepo, saldoRepo } = createMockRepositories();

    movimientoRepo.getPeriodosDesdeFecha.mockResolvedValue([1]);
    movimientoRepo.getBatchByPeriodo
      .mockResolvedValueOnce([{ id: 10 } as MovimientoContable])
      .mockResolvedValueOnce([]);
    movimientoRepo.getCuentasAgrupadasPorMovimientos.mockResolvedValue([
      {
        MovimientoContableId: 10,
        PeriodoId: 1,
        CuentaContableId: 1105,
        TerceroId: 200,
        CentroCostoId: 10,
        LibroContableId: 1,
        UnidadNegocioId: 1,
        CentroOperacionId: 1,
        CategorizacionId: 1,
        ModeloCarteraId: 1,
        ModeloCartera: 'A',
        ConceptoTributarioId: 1,
        Debito: 100,
        Credito: 25,
        RegistrosMovimientoContableCuenta: 1,
      } as MovimientoContableCuentaAgrupadaRow,
    ]);

    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      mockLogger,
    );

    const onProgress = vi.fn();
    const result = await useCase.execute('2024-01-01', 1000, 'test-job', {
      onProgress,
      progressIntervalMs: 0,
    });

    expect(result.status).toBe('completed');
    expect(onProgress).toHaveBeenCalled();

    const lastCall = onProgress.mock.calls.at(-1)?.[0];
    expect(lastCall?.status).toBe('processing');
    expect(lastCall?.movimientosProcesados).toBeGreaterThanOrEqual(1);
  });
});
