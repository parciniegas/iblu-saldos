import { describe, it, expect, vi } from 'vitest';
import { MessageProcessor } from '../../../src/api/rabbitmq/MessageProcessor.js';
import type { IMovimientoContableRepository } from '../../../src/application/abstractions/IMovimientoContableRepository.js';
import type { ISaldoContableRepository } from '../../../src/application/abstractions/ISaldoContableRepository.js';
import type { ISaldoContablePeriodoRepository } from '../../../src/application/abstractions/ISaldoContablePeriodoRepository.js';
import type { MovimientoContable } from '../../../src/domain/entities/MovimientoContable.js';
import type { SaldoContable } from '../../../src/domain/entities/SaldoContable.js';
import type { MovimientoContableCuentaAgrupadaRow } from '../../../src/application/contracts/MovimientoContableCuentaAgrupadaRow.js';
import type { SaldoContablePeriodo } from '../../../src/application/contracts/SaldoContablePeriodo.js';
import type { MovimientoContableEvent } from '../../../src/application/contracts/MovimientoContableEvent.js';

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
  getPeriodosDesdeIdOrdenadosMock: ReturnType<typeof vi.fn>;
} {
  const getPeriodosDesdeIdOrdenadosMock = vi.fn().mockResolvedValue([]);
  const movimientoRepo = {
    getCuentasAgrupadasPorMovimientos: vi.fn().mockResolvedValue([]),
    getPeriodosDesdeFecha: vi.fn().mockResolvedValue([]),
    getBatchByPeriodo: vi.fn().mockResolvedValue([]),
    getPeriodoPorFecha: vi.fn().mockResolvedValue(null),
  } as unknown as IMovimientoContableRepository;

  const saldoRepo = {
    getByKey: vi.fn().mockResolvedValue(null),
    updateByKey: vi.fn().mockResolvedValue(undefined),
    getByPeriodo: vi.fn().mockResolvedValue([]),
    bulkUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ISaldoContableRepository;

  const saldoPeriodoRepo = {
    getPeriodosDesdeFechaOrdenados: vi.fn().mockResolvedValue([]),
    getByNombre: vi.fn().mockResolvedValue(null),
    getUltimoPeriodo: vi.fn().mockResolvedValue(null),
    existsByNombre: vi.fn().mockResolvedValue(false),
    create: vi.fn().mockResolvedValue({ id: 1 }),
    getPeriodosDesdeIdOrdenados: getPeriodosDesdeIdOrdenadosMock,
  } as unknown as ISaldoContablePeriodoRepository;

  return { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock };
}

function createEvent(overrides: Partial<MovimientoContableEvent> = {}): MovimientoContableEvent {
  return {
    id: 100,
    fecha: new Date('2024-01-15'),
    estado: 'APROBADO',
    cuentas: [],
    Estado: 'Creado',
    CorrelationId: 'test-correlation-id',
    ...overrides,
  };
}

describe('MessageProcessor', () => {
  it('debe omitir el procesamiento cuando no hay periodos desde el PeriodoId del evento', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } = createMockRepositories();

    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue([]);

    const processor = new MessageProcessor(movimientoRepo, saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({ PeriodoId: 10 });

    await processor.process(event, 1000);

    expect(saldoRepo.getByPeriodo).not.toHaveBeenCalled();
    expect(movimientoRepo.getBatchByPeriodo).not.toHaveBeenCalled();
  });

  it('debe omitir cuando no hay periodos desde el PeriodoId del evento (caso 2)', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } = createMockRepositories();

    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue([]);

    const processor = new MessageProcessor(movimientoRepo, saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({ PeriodoId: 99 });

    await processor.process(event, 1000);

    expect(saldoRepo.getByPeriodo).not.toHaveBeenCalled();
  });

  it('debe procesar un evento "Creado" sumando Debito y Credito', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } =
      createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [{ id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false }];
    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue(periodos);

    movimientoRepo.getBatchByPeriodo
      .mockResolvedValueOnce([{ id: 100, periodoId: 10 } as MovimientoContable])
      .mockResolvedValueOnce([]);

    movimientoRepo.getCuentasAgrupadasPorMovimientos.mockResolvedValue([
      {
        MovimientoContableId: 100,
        PeriodoId: 10,
        CuentaContableId: 1105,
        TerceroId: 200,
        CentroCostoId: 10,
        Debito: 500,
        Credito: 150,
      } as unknown as MovimientoContableCuentaAgrupadaRow,
    ]);

    saldoRepo.getByPeriodo.mockResolvedValue([{ id: 1, periodoId: 10, terceroId: 200, cuentaContableId: 1105, centroCostoId: 10, debito: 0, credito: 0, saldoFinalDebito: 0, saldoFinalCredito: 0 } as SaldoContable]);

    const processor = new MessageProcessor(movimientoRepo, saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({
      PeriodoId: 10,
      cuentas: [
        {
          MovimientoContableId: 100,
          CuentaContableId: 1105,
          TerceroId: 200,
          CentroCostoId: 10,
          Debito: 500,
          Credito: 150,
        },
      ],
    });

    await processor.process(event, 1000);

    expect(saldoRepo.updateByKey).toHaveBeenCalledWith(
      expect.objectContaining({ PeriodoId: 10, TerceroId: 200, CuentaContableId: 1105 }),
      expect.objectContaining({
        Debito: 500,
        Credito: 150,
        SaldoFinalDebito: 500,
        SaldoFinalCredito: 150,
      }),
    );
  });

  it('debe procesar un evento "Borrado" restando Debito y Credito', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } =
      createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [{ id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false }];
    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue(periodos);

    movimientoRepo.getBatchByPeriodo
      .mockResolvedValueOnce([{ id: 100, periodoId: 10 } as MovimientoContable])
      .mockResolvedValueOnce([]);

    movimientoRepo.getCuentasAgrupadasPorMovimientos.mockResolvedValue([
      {
        MovimientoContableId: 100,
        PeriodoId: 10,
        CuentaContableId: 1105,
        TerceroId: 200,
        CentroCostoId: 10,
        Debito: 500,
        Credito: 150,
      } as unknown as MovimientoContableCuentaAgrupadaRow,
    ]);

    saldoRepo.getByPeriodo.mockResolvedValue([{ id: 1, periodoId: 10, terceroId: 200, cuentaContableId: 1105, centroCostoId: 10, debito: 0, credito: 0, saldoFinalDebito: 0, saldoFinalCredito: 0 } as SaldoContable]);

    const processor = new MessageProcessor(movimientoRepo, saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({
      PeriodoId: 10,
      Estado: 'Borrado',
      cuentas: [
        {
          MovimientoContableId: 100,
          CuentaContableId: 1105,
          TerceroId: 200,
          CentroCostoId: 10,
          Debito: 500,
          Credito: 150,
        },
      ],
    });

    await processor.process(event, 1000);

    expect(saldoRepo.updateByKey).toHaveBeenCalledWith(
      expect.objectContaining({ PeriodoId: 10, TerceroId: 200, CuentaContableId: 1105 }),
      expect.objectContaining({
        Debito: -500,
        Credito: -150,
        SaldoFinalDebito: -500,
        SaldoFinalCredito: -150,
      }),
    );
  });

  it('debe excluir el movimiento borrado de la agregación del periodo', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } =
      createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [{ id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false }];
    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue(periodos);

    movimientoRepo.getBatchByPeriodo
      .mockResolvedValueOnce([
        { id: 100, periodoId: 10 } as MovimientoContable,
        { id: 200, periodoId: 10 } as MovimientoContable,
      ])
      .mockResolvedValueOnce([]);

    // Solo se agrupan los movimientos que NO son el borrado (id 100)
    movimientoRepo.getCuentasAgrupadasPorMovimientos.mockResolvedValue([
      {
        MovimientoContableId: 200,
        PeriodoId: 10,
        CuentaContableId: 1105,
        TerceroId: 200,
        CentroCostoId: 10,
        Debito: 300,
        Credito: 100,
      } as unknown as MovimientoContableCuentaAgrupadaRow,
    ]);

    saldoRepo.getByPeriodo.mockResolvedValue([{ id: 1, periodoId: 10, terceroId: 200, cuentaContableId: 1105, centroCostoId: 10 } as SaldoContable]);

    const processor = new MessageProcessor(movimientoRepo, saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({
      PeriodoId: 10,
      id: 100,
      Estado: 'Borrado',
      cuentas: [
        {
          MovimientoContableId: 100,
          CuentaContableId: 1105,
          TerceroId: 200,
          CentroCostoId: 10,
          Debito: 500,
          Credito: 150,
        },
      ],
    });

    await processor.process(event, 1000);

    // Se debe llamar getCuentasAgrupadasPorMovimientos con [200] (excluyendo 100)
    expect(movimientoRepo.getCuentasAgrupadasPorMovimientos).toHaveBeenCalledWith([200]);
  });

  it('debe recalcular todos los periodos desde el periodo del movimiento', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } =
      createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [
      { id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false },
      { id: 20, nombre: '2024-02', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
      { id: 30, nombre: '2024-03', periodoInicio: new Date('2024-03-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue(periodos);

    movimientoRepo.getBatchByPeriodo.mockResolvedValue([]);
    saldoRepo.getByPeriodo.mockResolvedValue([]);

    const processor = new MessageProcessor(movimientoRepo, saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({ PeriodoId: 10 });

    await processor.process(event, 1000);

    expect(saldoRepo.getByPeriodo).toHaveBeenCalledTimes(3);
    const llamadas = (saldoRepo.getByPeriodo as any).mock.calls;
    expect(llamadas[0][0]).toBe(10);
    expect(llamadas[1][0]).toBe(20);
    expect(llamadas[2][0]).toBe(30);
  });

  it('debe procesar eventos con múltiples periodos aplicando saldo final del periodo anterior como inicial del siguiente', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } =
      createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [
      { id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false },
      { id: 20, nombre: '2024-02', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue(periodos);

    movimientoRepo.getBatchByPeriodo.mockResolvedValue([]);

    saldoRepo.getByPeriodo
      .mockResolvedValueOnce([{ id: 1, periodoId: 10, terceroId: 200, cuentaContableId: 1105, centroCostoId: 10, debito: 0, credito: 0, saldoFinalDebito: 500, saldoFinalCredito: 200 } as SaldoContable])
      .mockResolvedValueOnce([{ id: 2, periodoId: 20, terceroId: 200, cuentaContableId: 1105, centroCostoId: 10, debito: 0, credito: 0 } as SaldoContable]);

    const processor = new MessageProcessor(movimientoRepo, saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({
      PeriodoId: 10,
      cuentas: [
        {
          MovimientoContableId: 100,
          CuentaContableId: 1105,
          TerceroId: 200,
          CentroCostoId: 10,
          Debito: 100,
          Credito: 50,
        },
      ],
    });

    await processor.process(event, 1000);

    // Verificar que el periodo 20 recibe el saldoFinal del periodo 10 como saldoInicial
    const llamadasUpdate = (saldoRepo.updateByKey as any).mock.calls;
    const llamadaPeriodo20 = llamadasUpdate.find((c: any[]) => c[0].PeriodoId === 20);
    expect(llamadaPeriodo20).toBeDefined();
    expect(llamadaPeriodo20[1].SaldoInicialDebito).toBe(500);
    expect(llamadaPeriodo20[1].SaldoInicialCredito).toBe(200);
  });
});
