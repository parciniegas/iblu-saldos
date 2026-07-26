import type { ISaldoContablePeriodoRepository } from '../../application/abstractions/ISaldoContablePeriodoRepository.js';
import type { SaldoContablePeriodo } from '../../application/contracts/SaldoContablePeriodo.js';
import { prisma } from './PrismaService.js';

export class SaldoContablePeriodoRepository implements ISaldoContablePeriodoRepository {
  async getPeriodosDesdeFechaOrdenados(fechaDesde: Date): Promise<SaldoContablePeriodo[]> {
    const fechaNormalizada = new Date(Date.UTC(fechaDesde.getUTCFullYear(), fechaDesde.getUTCMonth(), 1));
    const rows = await prisma.saldoContablePeriodo.findMany({
      orderBy: { nombre: 'asc' },
      select: {
        id: true,
        nombre: true,
        periodoInicio: true,
        periodoFin: true,
        cierre: true,
        cierreAnio: true,
      },
    });

    const startIndex = rows.findIndex((r) => (r.periodoInicio ?? null) !== null && r.periodoInicio! >= fechaNormalizada);
    if (startIndex === -1) return [];

    const desdeInicio = rows.slice(startIndex);
    return desdeInicio.filter((r) => (r.periodoInicio ?? null) !== null && r.periodoInicio! >= fechaNormalizada).map((r) => ({
      id: Number(r.id),
      nombre: r.nombre,
      periodoInicio: r.periodoInicio ?? undefined,
      periodoFin: r.periodoFin ?? undefined,
      cierre: r.cierre,
      cierreAnio: r.cierreAnio,
    } satisfies SaldoContablePeriodo));
  }

  async existsByNombre(nombre: string): Promise<boolean> {
    const found = await prisma.saldoContablePeriodo.findFirst({ where: { nombre }, select: { id: true } });
    return !!found;
  }

  async getByNombre(nombre: string): Promise<SaldoContablePeriodo | null> {
    const row = await prisma.saldoContablePeriodo.findFirst({ where: { nombre } });
    if (!row) return null;
    return {
      id: Number(row.id),
      nombre: row.nombre,
      periodoInicio: row.periodoInicio ?? undefined,
      periodoFin: row.periodoFin ?? undefined,
      cierre: row.cierre,
      cierreAnio: row.cierreAnio,
    } satisfies SaldoContablePeriodo;
  }

  async getUltimoPeriodo(): Promise<SaldoContablePeriodo | null> {
    const row = await prisma.saldoContablePeriodo.findFirst({ orderBy: { nombre: 'desc' } });
    if (!row) return null;
    return {
      id: Number(row.id),
      nombre: row.nombre,
      periodoInicio: row.periodoInicio ?? undefined,
      periodoFin: row.periodoFin ?? undefined,
      cierre: row.cierre,
      cierreAnio: row.cierreAnio,
    } satisfies SaldoContablePeriodo;
  }

  async create(nombre: string, periodoInicio: Date, periodoFin: Date): Promise<{ id: number }> {
    const now = new Date();
    const created = await prisma.saldoContablePeriodo.create({
      data: {
        nombre,
        periodoInicio,
        periodoFin,
        cierre: false,
        cierreAnio: false,
        recalculoLogico: false,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    return { id: Number(created.id) };
  }
}
