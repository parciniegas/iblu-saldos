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
}
