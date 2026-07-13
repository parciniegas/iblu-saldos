# Copilot Instructions for saldos-node

## Project Scope
- This repository is a TypeScript Node.js backend for accounting balance processing.
- Runtime components are API, worker, and CLI.
- Core business behavior lives in `src/application/useCases/ProcesarSaldosContablesUseCase.ts`.

## Tech and Tooling
- Node.js 22, TypeScript with `moduleResolution: NodeNext`.
- Fastify API in `src/api/`.
- Prisma + MySQL in `prisma/schema.prisma` and `src/infrastructure/persistence/`.
- RabbitMQ messaging in `src/infrastructure/messaging/RabbitMqService.ts`.
- Tests use Vitest and live under `__tests__/`.

## Coding Conventions
- Preserve ESM imports with explicit `.js` extensions in TypeScript source.
- Keep strict typing; avoid introducing `any` unless unavoidable at infrastructure boundaries.
- Follow existing Spanish domain naming (`fechaDesde`, `periodoId`, `saldo`, `movimiento`).
- Keep batch-size constraints consistent with current limits (1000 to 10000) unless the change intentionally updates all call sites.
- Avoid moving root entry files (`server.ts`, `worker/worker.ts`, `cli.ts`) into `src/` unless all scripts and docs are updated together.

## API and Worker Patterns
- API route registration happens through `src/api/server.ts` and route modules in `src/api/routes/`.
- Auth behavior is centralized in `src/api/plugins/auth.ts`; route auth changes should be applied consistently.
- Worker queue processing is initialized in `worker/worker.ts` and uses `RabbitMqServiceImpl`.
- API and worker are resilient to DB startup failures; preserve this behavior unless explicitly changing reliability semantics.

## Testing Conventions
- Add or update tests in `__tests__/` with mirrored structure for changed business logic.
- For use-case logic changes, update `__tests__/application/ProcesarSaldosContablesUseCase.test.ts`.
- For API route or service behavior changes, add/update tests in `__tests__/api/`.
- Keep tests isolated from external services; use mocks for repositories and messaging.

## Maintenance Matrix
When modifying a file category, review and update the linked files in the same PR.

| If you change... | Also review/update... | Why |
|---|---|---|
| `src/application/useCases/ProcesarSaldosContablesUseCase.ts` | `src/application/abstractions/IMovimientoContableRepository.ts`, `src/application/abstractions/ISaldoContableRepository.ts`, `__tests__/application/ProcesarSaldosContablesUseCase.test.ts` | Use case contracts and expected behavior must stay aligned. |
| `src/api/routes/saldos.ts` | `src/api/plugins/auth.ts`, `cli.ts`, `__tests__/api/JobService.test.ts` (and add route tests if needed) | Endpoint behavior, auth assumptions, and user-facing CLI flow are coupled. |
| `src/api/services/FileBackedJobService.ts` or `src/api/services/createJobService.ts` | `src/api/routes/saldos.ts`, `__tests__/api/FileBackedJobService.test.ts`, `AGENTS.md` | Job persistence behavior and fallback strategy must stay aligned with API flow and docs. |
| `src/api/routes/health.ts` | `src/infrastructure/messaging/RabbitMqService.ts`, `__tests__/api/routes.test.ts` | Health contracts should reflect real runtime telemetry from messaging and DB integrations. |
| `src/api/config.ts` or `config.json` | `worker/worker.ts`, `cli.ts`, `src/api/server.ts`, `k8s/configmap.yaml`, `k8s/secret.yaml` | Config keys are shared across API, worker, CLI, and deployment manifests. |
| `prisma/schema.prisma` | `src/infrastructure/persistence/MovimientoContableRepository.ts`, `src/infrastructure/persistence/SaldoContableRepository.ts`, run `npx prisma generate` | Prisma client and repository queries must match schema changes. |
| `src/infrastructure/messaging/RabbitMqService.ts` | `worker/worker.ts`, `src/api/routes/saldos.ts` (`/queue` route), `config.json` rabbit settings | Queue publish/consume contracts and config must remain compatible. |
| Root entry files `server.ts`, `worker/worker.ts`, `cli.ts` | `package.json` scripts, `Dockerfile`, `AGENTS.md` commands section | Runtime entry points are operational interfaces used by scripts and docs. |
| `tsconfig.json` include/exclude rules | `package.json` build/dev scripts, test coverage expectations | Some files are intentionally excluded from type-checking and this affects quality gates. |

## Safe Change Checklist
- Run `npm run build` for type-check + Prisma generation.
- Run `npm test` for behavior regressions.
- If Prisma schema changed, run `npx prisma generate` explicitly and ensure generated client compatibility.
- If config keys changed, verify API + worker + CLI + k8s manifests still agree.
- Never commit real credentials in `config.json`.
