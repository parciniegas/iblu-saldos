#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIN_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10000;

function printHelp(): void {
  console.log(`
Saldos CLI - Procesamiento de saldos contables

Uso:
  node cli.js <accion> [opciones]

Acciones:
  preview     Muestra qué períodos se procesarían sin ejecutar
  procesar    Ejecuta el procesamiento de saldos (con polling de estado)
  queue       Publica un mensaje a la cola de RabbitMQ
  status      Muestra el estado de un job por jobId
  help        Muestra esta ayuda

Opciones:
  --fecha-desde <yyyy-MM-dd>    Fecha inicial para el procesamiento (default: desde config.json)
  --batch-size <N>              Tamaño de batch (1000-10000, default: desde config.json)
  --api-key <key>               API key para autenticación
  --api-url <url>               URL de la API (default: http://localhost:3000)
  --job-id <id>                 Job ID para consultar estado

Ejemplos:
  node cli.js preview --fecha-desde 2024-01-01 --api-key mi-key
  node cli.js procesar --fecha-desde 2024-01-01 --batch-size 2000 --api-key mi-key
  node cli.js queue --fecha-desde 2024-06-01 --batch-size 1000 --api-key mi-key
  node cli.js status --job-id abc-123-xyz --api-key mi-key
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];

      if (next && !next.startsWith('--')) {
        result[key] = next;
        i += 2;
      } else {
        result[key] = '';
        i += 1;
      }
    } else {
      i += 1;
    }
  }

  return result;
}

function loadConfig(): { fechaDesdeDefault: string; batchSizeDefault: number } {
  try {
    const configPath = resolve('config.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return {
      fechaDesdeDefault: config.procesamientoMovimientos?.fechaDesdeDefault || '2000-01-01',
      batchSizeDefault: config.procesamientoMovimientos?.batchSizeDefault || 1000,
    };
  } catch {
    return { fechaDesdeDefault: '2000-01-01', batchSizeDefault: 1000 };
  }
}

async function preview(args: Record<string, string>, config: any): Promise<void> {
  const fechaDesde = args['fecha-desde'] || config.fechaDesdeDefault;
  const batchSize = args['batch-size'] ? Number.parseInt(args['batch-size'], 10) : config.batchSizeDefault;
  const apiKey = args['api-key'];
  const apiUrl = args['api-url'] || 'http://localhost:3000';

  if (!apiKey) {
    console.error('Error: --api-key es requerido');
    process.exit(1);
  }

  const response = await fetch(`${apiUrl}/api/v1/saldos/preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ fechaDesde, batchSize }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`Error: ${data.error || 'Error desconocido'}`);
    if (data.details) console.error(data.details);
    process.exit(1);
  }

  console.log(`\nPreview de procesamiento:`);
  console.log(`  Fecha desde:  ${data.fechaDesde}`);
  console.log(`  Batch size:   ${data.batchSize}`);
  console.log(`  Períodos:     ${data.periodosCount}`);
  console.log(`  Períodos ID:  ${data.periodos.join(', ')}`);
  console.log(`\n  ${data.mensaje}`);
}

async function procesar(args: Record<string, string>, config: any): Promise<void> {
  const fechaDesde = args['fecha-desde'] || config.fechaDesdeDefault;
  const batchSize = args['batch-size'] ? Number.parseInt(args['batch-size'], 10) : config.batchSizeDefault;
  const apiKey = args['api-key'];
  const apiUrl = args['api-url'] || 'http://localhost:3000';

  if (!apiKey) {
    console.error('Error: --api-key es requerido');
    process.exit(1);
  }

  const response = await fetch(`${apiUrl}/api/v1/saldos/procesar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ fechaDesde, batchSize }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`Error: ${data.error || 'Error desconocido'}`);
    process.exit(1);
  }

  const jobId = data.jobId;

  console.log(`\nJob creado: ${jobId}`);
  console.log(`Estado inicial: ${data.status}`);
  console.log(`Fecha desde: ${data.fechaDesde}`);
  console.log(`Batch size: ${data.batchSize}`);
  console.log('\nEsperando resultado...');

  // Polling cada 2 segundos
  const pollInterval = setInterval(async () => {
    const statusResponse = await fetch(`${apiUrl}/api/v1/saldos/status/${jobId}`, {
      headers: { 'X-API-Key': apiKey },
    });

    const job = await statusResponse.json();

    if (job.status === 'completed') {
      clearInterval(pollInterval);
      console.log(`\n✅ Procesamiento completado:`);
      console.log(`  Job ID:           ${job.jobId}`);
      console.log(`  Períodos:         ${job.resultado?.periodosProcesados}`);
      console.log(`  Movimientos:      ${job.resultado?.movimientosProcesados}`);
      console.log(`  Mov. Cuentas:    ${job.resultado?.movimientosCuentaProcesados}`);
      console.log(`  Tiempo total:    ${job.resultado?.tiempoTotalMs}ms`);
      if (job.resultado?.eta) console.log(`  ETA:             ${job.resultado.eta}`);
      process.exit(0);
    } else if (job.status === 'failed') {
      clearInterval(pollInterval);
      console.log(`\n❌ Procesamiento fallido:`);
      console.log(`  Error: ${job.error}`);
      process.exit(1);
    } else {
      const elapsed = Date.now() - startTime;
      console.log(`  [${Math.floor(elapsed / 1000)}s] Estado: ${job.status}`);
    }
  }, 2000);

  const startTime = Date.now();

  // Timeout después de 1 hora
  setTimeout(() => {
    clearInterval(pollInterval);
    console.log('\n⏱ Timeout: procesamiento excedió 1 hora');
    process.exit(1);
  }, 60 * 60 * 1000);
}

async function queue(args: Record<string, string>, config: any): Promise<void> {
  const fechaDesde = args['fecha-desde'] || config.fechaDesdeDefault;
  const batchSize = args['batch-size'] ? Number.parseInt(args['batch-size'], 10) : config.batchSizeDefault;
  const apiKey = args['api-key'];
  const apiUrl = args['api-url'] || 'http://localhost:3000';

  if (!apiKey) {
    console.error('Error: --api-key es requerido');
    process.exit(1);
  }

  const response = await fetch(`${apiUrl}/api/v1/saldos/queue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ fechaDesde, batchSize }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`Error: ${data.error || 'Error desconocido'}`);
    process.exit(1);
  }

  console.log(`\n✅ Mensaje publicado a RabbitMQ:`);
  console.log(`  Cola:    ${data.queueName}`);
  console.log(`  Fecha:   ${data.fechaDesde}`);
  console.log(`  Batch:   ${data.batchSize}`);
}

async function status(args: Record<string, string>): Promise<void> {
  const jobId = args['job-id'];
  const apiKey = args['api-key'];
  const apiUrl = args['api-url'] || 'http://localhost:3000';

  if (!jobId) {
    console.error('Error: --job-id es requerido para status');
    process.exit(1);
  }

  if (!apiKey) {
    console.error('Error: --api-key es requerido');
    process.exit(1);
  }

  const response = await fetch(`${apiUrl}/api/v1/saldos/status/${jobId}`, {
    headers: { 'X-API-Key': apiKey },
  });

  const job = await response.json();

  if (!response.ok) {
    console.error(`Error: ${job.error || 'Job no encontrado'}`);
    process.exit(1);
  }

  console.log(`\nEstado del job:`);
  console.log(`  Job ID:           ${job.jobId}`);
  console.log(`  Estado:           ${job.status}`);
  console.log(`  Fecha desde:      ${job.fechaDesde}`);
  console.log(`  Batch size:       ${job.batchSize}`);
  console.log(`  Creado:           ${job.createdAt}`);
  console.log(`  Actualizado:      ${job.updatedAt}`);

  if (job.resultado) {
    console.log(`\nResultados:`);
    console.log(`  Períodos:         ${job.resultado.periodosProcesados}`);
    console.log(`  Movimientos:      ${job.resultado.movimientosProcesados}`);
    console.log(`  Mov. Cuentas:    ${job.resultado.movimientosCuentaProcesados}`);
    console.log(`  Tiempo total:    ${job.resultado.tiempoTotalMs}ms`);
    if (job.resultado.eta) console.log(`  ETA:             ${job.resultado.eta}`);
  }

  if (job.error) {
    console.log(`\nError: ${job.error}`);
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === 'help' || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const config = loadConfig();
  const action = rawArgs[0];
  const args = parseArgs(rawArgs.slice(1));

  switch (action) {
    case 'preview':
      await preview(args, config);
      break;
    case 'procesar':
      await procesar(args, config);
      break;
    case 'queue':
      await queue(args, config);
      break;
    case 'status':
      await status(args);
      break;
    default:
      console.error(`Error: acción desconocida '${action}'`);
      printHelp();
      process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
