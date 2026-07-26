import type { ISaldoContablePeriodoRepository } from '../abstractions/ISaldoContablePeriodoRepository.js';
import type { ISaldoContableRepository } from '../abstractions/ISaldoContableRepository.js';

export type CrearPeriodoResult = {
  id: number;
  nombre: string;
  periodoInicio: Date;
  periodoFin: Date;
  saldosCreados: number;
  saldosVerificados: number;
};

export class PeriodoYaExisteError extends Error {
  constructor(public readonly nombre: string) {
    super(`El periodo ${nombre} ya existe`);
    this.name = 'PeriodoYaExisteError';
  }
}

export class PeriodoSinAnteriorError extends Error {
  constructor(public readonly nombre: string) {
    super(`No existe periodo anterior a ${nombre}`);
    this.name = 'PeriodoSinAnteriorError';
  }
}

export class PeriodoNoInmediatoAnteriorError extends Error {
  constructor(public readonly ultimoNombre: string, public readonly esperadoAnterior: string) {
    super(`El último periodo es ${ultimoNombre} y no es el inmediatamente anterior (${esperadoAnterior})`);
    this.name = 'PeriodoNoInmediatoAnteriorError';
  }
}

export class CreatePeriodoUseCase {
  constructor(
    private readonly periodoRepo: ISaldoContablePeriodoRepository,
    private readonly saldoRepo: ISaldoContableRepository,
  ) {}

  async execute(fecha: Date): Promise<CrearPeriodoResult> {
    const { nombre, inicioUTC, finUTC, year, month0 } = this.computePeriodoFromFecha(fecha);

    if (await this.periodoRepo.existsByNombre(nombre)) {
      throw new PeriodoYaExisteError(nombre);
    }

    const ultimo = await this.periodoRepo.getUltimoPeriodo();
    if (!ultimo) {
      throw new PeriodoSinAnteriorError(nombre);
    }

    const esperadoAnterior = this.nombreYYYYMM(this.computePrevYearMonth(year, month0));
    if (ultimo.nombre !== esperadoAnterior) {
      throw new PeriodoNoInmediatoAnteriorError(ultimo.nombre, esperadoAnterior);
    }

    // Crear periodo y clonar saldos
    const created = await this.periodoRepo.create(nombre, inicioUTC, finUTC);
    const saldosCreados = await this.saldoRepo.copyFromPeriodo(ultimo.id, created.id);
    const saldosVerificados = await this.saldoRepo.countByPeriodo(created.id);

    return {
      id: created.id,
      nombre,
      periodoInicio: inicioUTC,
      periodoFin: finUTC,
      saldosCreados,
      saldosVerificados,
    };
  }

  private computePeriodoFromFecha(fecha: Date): { nombre: string; inicioUTC: Date; finUTC: Date; year: number; month0: number } {
    const year = fecha.getUTCFullYear();
    const month0 = fecha.getUTCMonth();
    const inicioUTC = new Date(Date.UTC(year, month0, 1, 0, 0, 0, 0));
    const finUTC = new Date(Date.UTC(year, month0 + 1, 0, 23, 59, 59, 999));
    const nombre = this.nombreYYYYMM({ year, month0 });
    return { nombre, inicioUTC, finUTC, year, month0 };
  }

  private nombreYYYYMM({ year, month0 }: { year: number; month0: number }): string {
    const mm = String(month0 + 1).padStart(2, '0');
    return `${year}${mm}`;
  }

  private computePrevYearMonth(year: number, month0: number): { year: number; month0: number } {
    const prevMonth = month0 - 1;
    if (prevMonth >= 0) return { year, month0: prevMonth };
    return { year: year - 1, month0: 11 };
  }
}
