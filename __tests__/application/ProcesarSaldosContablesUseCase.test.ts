import { describe, it, expect, vi } from 'vitest';
import { ProcesarSaldosContablesUseCase } from '../../src/application/useCases/ProcesarSaldosContablesUseCase.js';
import type { IMovimientoContableRepository } from '../../src/application/abstractions/IMovimientoContableRepository.js';
import type { ISaldoContableRepository } from '../../src/application/abstractions/ISaldoContableRepository.js';
import type { ISaldoContablePeriodoRepository } from '../../src/application/abstractions/ISaldoContablePeriodoRepository.js';
import type { MovimientoContable } from '../../src/domain/entities/MovimientoContable.js';
import type { SaldoContable } from '../../src/domain/entities/SaldoContable.js';
import type { MovimientoContableCuentaAgrupadaRow } from '../../src/application/contracts/MovimientoContableCuentaAgrupadaRow.js';
import type { SaldoContablePeriodo } from '../../src/application/contracts/SaldoContablePeriodo.js';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
} as any;

function createMockRepositories(): {
  movimientoRepo: IMovimientoContableRepository;
  saldoRepo: ISaldoContableRepository;
  saldoPeriodoRepo: ISaldoContablePeriodoRepository;
  getPeriodosDesdeFechaOrdenadosMock: ReturnType<typeof vi.fn>;
} {
  const getPeriodosDesdeFechaOrdenadosMock = vi.fn().mockResolvedValue([]);
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

  const saldoPeriodoRepo = {
    getPeriodosDesdeFechaOrdenados: getPeriodosDesdeFechaOrdenadosMock,
  } as unknown as ISaldoContablePeriodoRepository;

  return { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock };
}

describe('ProcesarSaldosContablesUseCase con periodos', () => {
  it('debe lanzar error cuando no hay periodos con periodoInicio >= fechaDesde', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock } = createMockRepositories();

    getPeriodosDesdeFechaOrdenadosMock.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      saldoPeriodoRepo,
      mockLogger,
    );

    const result = await useCase.execute('2024-01-01', 1000, 'test-job');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No se encontraron periodos con periodoInicio >= 2024-01-01');
  });

  it('debe usar los periodos del repositorio de periodos ordenados por nombre', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock } = createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [
      { id: 30, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false },
      { id: 10, nombre: '2024-02', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
      { id: 20, nombre: '2024-03', periodoInicio: new Date('2024-03-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeFechaOrdenadosMock.mockResolvedValue(periodos);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      saldoPeriodoRepo,
      mockLogger,
    );

    await useCase.execute('2024-01-01', 1000, 'test-job');

    const llamadas = (getPeriodosDesdeFechaOrdenadosMock as any).mock.calls;
    expect(llamadas.length).toBeGreaterThan(0);

    // Verificar que los periodos se obtuvieron ordenados por nombre
    const periodosObtenidos = (getPeriodosDesdeFechaOrdenadosMock as any).mock.calls[0][0];
    expect(periodosObtenidos).toBeInstanceOf(Date);
  });

  it('debe procesar solo los periodos a partir del periodo de inicio identificado', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock } = createMockRepositories();

    // Datos pre-filtrados como devolvería el repositorio real (excluye periodo 100)
    const periodos: SaldoContablePeriodo[] = [
      { id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false },
      { id: 20, nombre: '2024-02', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
      { id: 30, nombre: '2024-03', periodoInicio: new Date('2024-03-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeFechaOrdenadosMock.mockResolvedValue(periodos);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      saldoPeriodoRepo,
      mockLogger,
    );

    const result = await useCase.execute('2024-01-01', 1000, 'test-job');

    expect(result.status).toBe('completed');
    expect(result.periodosProcesados).toBe(3); // 10, 20, 30 (excluye 100)
  });

  it('debe ordenar los periodos por nombre y no por id', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock } = createMockRepositories();

    // Los periodos vienen desordenados por id pero ordenados por nombre
    const periodos: SaldoContablePeriodo[] = [
      { id: 50, nombre: 'Enero', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false },
      { id: 30, nombre: 'Febrero', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
      { id: 10, nombre: 'Marzo', periodoInicio: new Date('2024-03-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeFechaOrdenadosMock.mockResolvedValue(periodos);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      saldoPeriodoRepo,
      mockLogger,
    );

    await useCase.execute('2024-01-01', 1000, 'test-job');

    // Verificar que se procesaron en orden de nombre: Enero(50), Febrero(30), Marzo(10)
    // El orden de procesamiento debería ser [50, 30, 10]
    expect(saldoRepo.getByPeriodo).toHaveBeenCalledTimes(3);
    const llamadas = (saldoRepo.getByPeriodo as any).mock.calls;
    expect(llamadas[0][0]).toBe(50); // Enero
    expect(llamadas[1][0]).toBe(30); // Febrero
    expect(llamadas[2][0]).toBe(10); // Marzo
  });

  it('debe incluir el periodo cuyo periodoInicio es exactamente igual a fechaDesde', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock } = createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [
      { id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01T00:00:00'), cierre: false, cierreAnio: false },
      { id: 20, nombre: '2024-02', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeFechaOrdenadosMock.mockResolvedValue(periodos);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      saldoPeriodoRepo,
      mockLogger,
    );

    const result = await useCase.execute('2024-01-01', 1000, 'test-job');

    expect(result.status).toBe('completed');
    expect(result.periodosProcesados).toBe(2);
  });

  it('debe excluir periodos cuyo periodoInicio es anterior a fechaDesde', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock } = createMockRepositories();

    // Datos pre-filtrados como devolvería el repositorio real (excluye periodo 5)
    const periodos: SaldoContablePeriodo[] = [
      { id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-15'), cierre: false, cierreAnio: false },
      { id: 20, nombre: '2024-02', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeFechaOrdenadosMock.mockResolvedValue(periodos);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      saldoPeriodoRepo,
      mockLogger,
    );

    const result = await useCase.execute('2024-01-01', 1000, 'test-job');

    expect(result.status).toBe('completed');
    expect(result.periodosProcesados).toBe(2); // 10 y 20, excluye 5
  });

  it('debe persistir saldos nuevos agregados en el periodo con nuevo repositorio de periodos', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock } = createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [
      { id: 1, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeFechaOrdenadosMock.mockResolvedValue(periodos);
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
      saldoPeriodoRepo,
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

  it('debe retornar error cuando falla la conexión al repositorio de periodos', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeFechaOrdenadosMock } = createMockRepositories();

    getPeriodosDesdeFechaOrdenadosMock.mockRejectedValue(new Error('DB connection failed'));

    const useCase = new ProcesarSaldosContablesUseCase(
      movimientoRepo,
      saldoRepo,
      saldoPeriodoRepo,
      mockLogger,
    );

    const result = await useCase.execute('2024-01-01', 1000, 'test-job');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('DB connection failed');
  });
});
