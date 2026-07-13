import pino from 'pino';
import { connectPrisma, disconnectPrisma, prisma } from '../src/infrastructure/persistence/PrismaService.js';
import { SaldoContableRepository } from '../src/infrastructure/persistence/SaldoContableRepository.js';
import type { SaldoContable } from '../src/domain/entities/SaldoContable.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const CHUNK_ENV = 'SALDOS_BULK_UPDATE_CHUNK_SIZE';
const DEFAULT_SIZES = [10_000, 50_000, 100_000];
const DEFAULT_CHUNKS = [200, 500, 1000, 2000];
const DEFAULT_ROUNDS = 1;
const PERIODO_STEP = 10;

function parseNumberList(value: string | undefined, fallback: number[]): number[] {
  if (!value || value.trim().length === 0) return fallback;

  const parsed = value
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  return parsed.length > 0 ? parsed : fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function buildInsertPayload(periodoId: number, count: number): SaldoContable[] {
  const rows: SaldoContable[] = [];

  for (let i = 0; i < count; i++) {
    const debito = (i % 100) + 1;
    const credito = i % 25;
    rows.push({
      id: 0,
      periodoId,
      terceroId: (i % 20_000) + 1,
      cuentaContableId: 1000 + (i % 500),
      centroCostoId: 1 + (i % 100),
      saldoInicialDebito: 0,
      saldoInicialCredito: 0,
      debito,
      credito,
      saldoFinalDebito: debito,
      saldoFinalCredito: credito,
      cierre: false,
    });
  }

  return rows;
}

function buildUpdatePayload(rows: SaldoContable[]): SaldoContable[] {
  return rows.map((row, idx) => {
    const debito = row.debito + 10 + (idx % 7);
    const credito = row.credito + 5 + (idx % 3);
    return {
      ...row,
      saldoInicialDebito: row.saldoFinalDebito,
      saldoInicialCredito: row.saldoFinalCredito,
      debito,
      credito,
      saldoFinalDebito: row.saldoFinalDebito + debito,
      saldoFinalCredito: row.saldoFinalCredito + credito,
      cierre: idx % 2 === 0,
    };
  });
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function measureMs(action: () => Promise<void>): Promise<number> {
  const start = process.hrtime.bigint();
  await action();
  const elapsedNs = process.hrtime.bigint() - start;
  return Number(elapsedNs) / 1_000_000;
}

async function cleanupPeriodo(periodoId: number): Promise<void> {
  await prisma.saldoContable.deleteMany({ where: { periodoId } });
}

type ScenarioResult = {
  chunk: number;
  size: number;
  round: number;
  insertMs: number;
  fetchMs: number;
  updateMs: number;
  totalMs: number;
};

function printResults(results: ScenarioResult[]): void {
  console.log('\nBenchmark results:');
  console.table(
    results.map((result) => ({
      chunk: result.chunk,
      size: result.size,
      round: result.round,
      insert: formatMs(result.insertMs),
      fetch: formatMs(result.fetchMs),
      update: formatMs(result.updateMs),
      total: formatMs(result.totalMs),
      updateRowsPerSec: Math.round((result.size / result.updateMs) * 1000),
    })),
  );
}

async function run(): Promise<void> {
  const sizes = parseNumberList(process.env.BENCH_SIZES, DEFAULT_SIZES);
  const chunks = parseNumberList(process.env.BENCH_CHUNKS, DEFAULT_CHUNKS);
  const rounds = parseNumber(process.env.BENCH_ROUNDS, DEFAULT_ROUNDS);
  const periodoBase = parseNumber(process.env.BENCH_PERIODO_BASE, 9_000_000 + Date.now() % 100_000);

  logger.info({ sizes, chunks, rounds, periodoBase }, 'Starting bulkUpdate benchmark');

  await connectPrisma();

  const repository = new SaldoContableRepository();
  const results: ScenarioResult[] = [];
  let scenarioIndex = 0;

  try {
    for (const chunk of chunks) {
      process.env[CHUNK_ENV] = String(chunk);

      for (const size of sizes) {
        for (let round = 1; round <= rounds; round++) {
          scenarioIndex += 1;
          const periodoId = periodoBase + scenarioIndex * PERIODO_STEP;

          const insertPayload = buildInsertPayload(periodoId, size);

          const insertMs = await measureMs(async () => {
            await repository.bulkUpdate(insertPayload);
          });

          let insertedRows: SaldoContable[] = [];
          const fetchMs = await measureMs(async () => {
            insertedRows = await repository.getByPeriodo(periodoId);
          });

          const updatePayload = buildUpdatePayload(insertedRows);
          const updateMs = await measureMs(async () => {
            await repository.bulkUpdate(updatePayload);
          });

          results.push({
            chunk,
            size,
            round,
            insertMs,
            fetchMs,
            updateMs,
            totalMs: insertMs + fetchMs + updateMs,
          });

          logger.info({ chunk, size, round, periodoId, insertMs, fetchMs, updateMs }, 'Scenario finished');

          await cleanupPeriodo(periodoId);
        }
      }
    }

    printResults(results);
  } finally {
    await disconnectPrisma();
  }
}

try {
  await run();
} catch (error) {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Benchmark failed');
  await disconnectPrisma();
  process.exit(1);
}
