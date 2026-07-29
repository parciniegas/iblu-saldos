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

    const processor = new MessageProcessor(saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({ PeriodoId: 10 });

    await processor.process(event, 1000);

    expect(saldoRepo.getByPeriodo).not.toHaveBeenCalled();
    expect(movimientoRepo.getBatchByPeriodo).not.toHaveBeenCalled();
  });

  it('debe omitir cuando no hay periodos desde el PeriodoId del evento (caso 2)', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } = createMockRepositories();

    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue([]);

    const processor = new MessageProcessor(saldoRepo, saldoPeriodoRepo, mockLogger);
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

    const processor = new MessageProcessor(saldoRepo, saldoPeriodoRepo, mockLogger);
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
      expect.anything(),
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

    const processor = new MessageProcessor(saldoRepo, saldoPeriodoRepo, mockLogger);
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
      expect.anything(),
    );
  });

  it('no usa agregación por movimientos; aplica deltas del evento directamente por clave', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } = createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [{ id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false }];
    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue(periodos);

    const processor = new MessageProcessor(saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({
      PeriodoId: 10,
      cuentas: [
        { MovimientoContableId: 100, CuentaContableId: 1105, TerceroId: 200, CentroCostoId: 10, Debito: 300, Credito: 100 } as any,
      ],
    });

    await processor.process(event, 1000);

    expect(movimientoRepo.getCuentasAgrupadasPorMovimientos).not.toHaveBeenCalled();
    expect(movimientoRepo.getBatchByPeriodo).not.toHaveBeenCalled();
    expect(saldoRepo.updateByKey).toHaveBeenCalledWith(
      expect.objectContaining({ PeriodoId: 10, CuentaContableId: 1105, TerceroId: 200 }),
      expect.objectContaining({ Debito: 300, Credito: 100 }),
      expect.anything(),
    );
  });

  it('debe aplicar deltas a todos los periodos desde el periodo del movimiento', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } =
      createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [
      { id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false },
      { id: 20, nombre: '2024-02', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
      { id: 30, nombre: '2024-03', periodoInicio: new Date('2024-03-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue(periodos);

    const processor = new MessageProcessor(saldoRepo, saldoPeriodoRepo, mockLogger);
    const event = createEvent({ PeriodoId: 10, cuentas: [{ MovimientoContableId: 1, CuentaContableId: 1, Debito: 10, Credito: 5 } as any] });

    await processor.process(event, 1000);
    const updates = (saldoRepo.updateByKey as any).mock.calls.map((c: any[]) => c[0].PeriodoId);
    expect(updates).toEqual(expect.arrayContaining([10, 20, 30]));
  });

  it('debe procesar eventos con múltiples periodos aplicando saldo final del periodo anterior como inicial del siguiente', async () => {
    const { movimientoRepo, saldoRepo, saldoPeriodoRepo, getPeriodosDesdeIdOrdenadosMock } =
      createMockRepositories();

    const periodos: SaldoContablePeriodo[] = [
      { id: 10, nombre: '2024-01', periodoInicio: new Date('2024-01-01'), cierre: false, cierreAnio: false },
      { id: 20, nombre: '2024-02', periodoInicio: new Date('2024-02-01'), cierre: false, cierreAnio: false },
    ];
    getPeriodosDesdeIdOrdenadosMock.mockResolvedValue(periodos);

    // Simular que en p0 no existe saldo previo (para que inicial de p1 sea igual al delta aplicado en p0)
    (saldoRepo.getByKey as any).mockResolvedValue(null);

    const processor = new MessageProcessor(saldoRepo, saldoPeriodoRepo, mockLogger);
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
    // Inicial de p1 debe ser igual a final de p0 (que corresponde al delta aplicado 100/50)
    expect(llamadaPeriodo20[1].SaldoInicialDebito).toBe(100);
    expect(llamadaPeriodo20[1].SaldoInicialCredito).toBe(50);
    // En pi>0 no se deben aplicar deltas a Debito/Credito
    expect(Object.hasOwn(llamadaPeriodo20[1], 'Debito')).toBe(false);
    expect(Object.hasOwn(llamadaPeriodo20[1], 'Credito')).toBe(false);
  });
});
