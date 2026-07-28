import amqplib from 'amqplib';
import { PrismaClient } from '@prisma/client';
import { buildMovimientoEvent } from './lib/buildMovimientoEvent.js';

async function main() {
  const idArg = process.argv[2];
  const estado = (process.argv[3] as 'Creado' | 'Borrado' | undefined) ?? 'Creado';
  if (!idArg) {
    console.error('Uso: tsx scripts/publishMovimientoEvent.ts <MovimientoContableCuentaId|MovimientoContableId> [Creado|Borrado] [queueName]');
    process.exit(1);
  }
  const queueName = (process.argv[4] as string | undefined) ?? process.env.RABBITMQ_QUEUE ?? 'saldos_movimientos';
  const url = process.env.RABBITMQ_URL ?? 'amqp://admin:P2ssw0rd@docker:5672';

  const prisma = new PrismaClient();
  try {
    const event = await buildMovimientoEvent(prisma, Number(idArg), estado);

    const conn = await amqplib.connect(url);
    const ch = await conn.createChannel();
    await ch.assertQueue(queueName, {
      durable: true,
      arguments: {
        'x-message-ttl': 60000,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': `${queueName}.dlq`,
      },
    });
    const payload = Buffer.from(JSON.stringify(event));
    const ok = ch.sendToQueue(queueName, payload, {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId: String(event.id),
      correlationId: event.CorrelationId,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'MovimientoContableEvent',
    });
    await ch.close();
    await conn.close();
    await prisma.$disconnect();
    if (!ok) {
      console.error('No se pudo encolar el mensaje (sendToQueue devolvió false)');
      process.exit(2);
    }
    console.log(`Publicado en ${queueName}. movimientoId=${event.id}, correlationId=${event.CorrelationId}`);
  } catch (err) {
    await prisma.$disconnect();
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(99);
  }
}

main();
