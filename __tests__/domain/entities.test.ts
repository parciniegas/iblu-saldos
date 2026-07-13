import { describe, it, expect, vi } from 'vitest';
import type { MovimientoContable } from '../src/domain/entities/MovimientoContable.js';
import type { MovimientoContableCuenta } from '../src/domain/entities/MovimientoContableCuenta.js';
import type { SaldoContable } from '../src/domain/entities/SaldoContable.js';

describe('Domain Entities', () => {
  it('MovimientoContable debe tener todas las propiedades requeridas', () => {
    const mock: MovimientoContable = {
      id: 1,
      consecutivo: 1,
      estado: 'APROBADO',
      fecha: new Date(),
      cerrado: false,
    };

    expect(mock.id).toBeTypeOf('number');
    expect(mock.consecutivo).toBeTypeOf('number');
    expect(mock.estado).toBeTypeOf('string');
    expect(mock.fecha).toBeInstanceOf(Date);
    expect(mock.cerrado).toBeTypeOf('boolean');
  });

  it('MovimientoContableCuenta debe tener propiedades numéricas para montos', () => {
    const mock: MovimientoContableCuenta = {
      id: 1,
      movimientoContableId: 1,
      cuentaContableId: 1,
      base: 0,
      debito: 0,
      credito: 0,
      trm: 0,
      factorConversion: 0,
    };

    expect(mock.base).toBeTypeOf('number');
    expect(mock.debito).toBeTypeOf('number');
    expect(mock.credito).toBeTypeOf('number');
  });

  it('SaldoContable debe tener propiedades de saldo como números', () => {
    const mock: SaldoContable = {
      id: 1,
      periodoId: 1,
      saldoInicialDebito: 0,
      saldoInicialCredito: 0,
      debito: 0,
      credito: 0,
      saldoFinalDebito: 0,
      saldoFinalCredito: 0,
      cierre: false,
    };

    expect(mock.saldoInicialDebito).toBeTypeOf('number');
    expect(mock.saldoFinalDebito).toBeTypeOf('number');
    expect(mock.saldoFinalCredito).toBeTypeOf('number');
  });
});
