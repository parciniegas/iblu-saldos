# saldos-node

Node.js accounting balance processing API. Fastify API + Prisma/MySQL, TypeScript.

## Setup

```bash
npm ci          # install (uses pnpm-lock.yaml but npm ci works)
npx prisma generate  # generate Prisma client (required before any run)
```

## Commands

| Command | Description |
| --- | --- |
| `npm run build` | `tsc && prisma generate` (build + regenerate client) |
| `npm start` | Run API server (`tsx src/main.ts`) |
| `npm run dev:api` | Hot-reload API via `tsx watch src/api/server.ts` |
| `npm test` | Run all tests (`vitest run`) |
| `npm run test:coverage` | Tests with v8 coverage |

## Architecture

```text
src/
  api/              # Fastify HTTP API (entry: server.ts)
    server.ts       # Fastify app, registers routes, decorates repos
    config.ts       # Config: loads config.json, overrides with env vars
    routes/saldos.ts   # POST /api/v1/saldos/preview|procesar, GET jobs/status endpoints
    routes/health.ts   # GET /health|/health/detailed|/health/metrics
    plugins/auth.ts    # X-API-Key auth plugin
    services/JobService.ts     # Persistent job tracking (DB-backed)
    services/InMemoryJobService.ts  # In-memory alternative (tests)
    services/FileBackedJobService.ts  # Durable JSON-backed jobs store
    services/createJobService.ts      # Factory with fallback to in-memory
  application/
    useCases/ProcesarSaldosContablesUseCase.ts  # Core business logic
    abstractions/IMovimientoContableRepository.ts
    abstractions/ISaldoContableRepository.ts
    contracts/  # DTO types
  domain/
    entities/    # SaldoContable, MovimientoContable, MovimientoContableCuenta
    types/       # SaldoContableKey, SaldoBaseKey, etc.
  infrastructure/
    persistence/  # PrismaService, MovimientoContableRepository, SaldoContableRepository
```

**Single process:**

- **API** (`server.ts`): Fastify on port 3000, exposes async job management REST API

**Processing flow:** `ProcesarSaldosContablesUseCase` iterates periods in ascending order, zero-initializes saldos, batches movements (1000–10000), aggregates accounts, computes `SaldoFinal` → next period's `SaldoInicial`.

## Config

- File: `config.json` (root)
- Env override keys: `ConnectionStrings__MariaDb`, `Server__Port`, `Server__Host`
- Optional env for durable jobs store path: `SALDOS_JOB_STORE_PATH` (default `logs/jobs-store.json`)

## Testing

Tests live in `__tests__/` mirroring source structure:

- `__tests__/domain/entities.test.ts` — type shape checks
- `__tests__/application/ProcesarSaldosContablesUseCase.test.ts` — use case logic with mocked repos
- `__tests__/api/JobService.test.ts` — InMemoryJobService

Tests use `vitest` with `globals: true`. No external services required — all repos are mocked.

## Deployment

- Dockerfile: multi-stage (Node 22 Alpine). `prisma generate` runs in builder stage.
- `k8s/`: deployment, service, ingress, configmap, secret manifests
- Runs as non-root user (`appuser:appgroup`)

## Gotchas

- `tsconfig.json` excludes `scripts/` — they are NOT type-checked by `tsc`. Run `tsx` directly for scripts.
- `noUnusedLocals` and `noUnusedParameters` are enabled — dead code will fail typecheck.
- `prisma generate` must run before any database access. The Dockerfile and `npm run build` handle this, but standalone `tsx` invocations do not.
- Config embeds credentials — never commit `config.json` with real secrets. Use env overrides in production.
- API tolerates DB unavailability at startup, but processing endpoints require DB dependencies.
