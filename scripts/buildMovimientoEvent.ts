import { PrismaClient } from '@prisma/client';
import { buildMovimientoEvent } from './lib/buildMovimientoEvent.js';

async function main() {
  const prisma = new PrismaClient();
  try {
    const argId = process.argv[2];
    if (!argId) {
      console.error('Uso: tsx scripts/buildMovimientoEvent.ts <MovimientoContableCuentaId> [Creado|Borrado]');
      process.exit(1);
    }
    const movimientoCuentaId = Number(argId);
    const eventoEstado = (process.argv[3] as 'Creado' | 'Borrado' | undefined) ?? 'Creado';

    const event = await buildMovimientoEvent(prisma, movimientoCuentaId, eventoEstado);

    console.log(JSON.stringify(event, null, 2));
    await prisma.$disconnect();
  } catch (err) {
    await prisma.$disconnect();
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(99);
  }
}

main();
