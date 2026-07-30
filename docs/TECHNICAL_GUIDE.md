# Guía Técnica de Despliegue y Uso — `saldos-node`

> **Audiencia:** ingenieros y operadores de nivel junior (conocimiento básico de Node.js, TypeScript, MySQL, Docker y Kubernetes).
>
> **Objetivo:** entregar una guía autocontenida que permita instalar, entender, configurar, operar, desplegar, monitorear, autenticar y consumir la API REST del proyecto `saldos-node`, así como diagnosticar y resolver problemas frecuentes.

---

## Tabla de contenido

1. [Visión general y alcance](#1-visión-general-y-alcance)
2. [Arquitectura](#2-arquitectura)
3. [Stack tecnológico y dependencias](#3-stack-tecnológico-y-dependencias)
4. [Prerrequisitos de infraestructura](#4-prerrequisitos-de-infraestructura)
5. [Modelo de datos (DDL)](#5-modelo-de-datos-ddl)
6. [Instalación local paso a paso](#6-instalación-local-paso-a-paso)
7. [Configuración](#7-configuración)
8. [Modelo de Jobs y máquina de estados](#8-modelo-de-jobs-y-máquina-de-estados)
9. [Catálogo de endpoints HTTP](#9-catálogo-de-endpoints-http)
10. [Mecanismo de autenticación y autorización](#10-mecanismo-de-autenticación-y-autorización)
11. [Procesamiento batch (sincrónico, manual)](#11-procesamiento-batch-sincrónico-manual)
12. [Procesamiento incremental por RabbitMQ](#12-procesamiento-incremental-por-rabbitmq)
13. [Idempotencia y `processed_events`](#13-idempotencia-y-processed_events)
14. [Schedulers](#14-schedulers)
15. [Catálogo de errores](#15-catálogo-de-errores)
16. [Catálogo de eventos RabbitMQ](#16-catálogo-de-eventos-rabbitmq)
17. [Logs y trazabilidad](#17-logs-y-trazabilidad)
18. [Despliegue](#18-despliegue)
19. [Operación, monitoreo y tuning](#19-operación-monitoreo-y-tuning)
20. [Pruebas (tests)](#20-pruebas-tests)
21. [Troubleshooting](#21-troubleshooting)
22. [Apéndices](#22-apéndices)

---

## 1. Visión general y alcance

`saldos-node` es un servicio API HTTP escrito en Node.js (TypeScript) cuya función es calcular y mantener **saldos contables por periodo y por una clave de 9 dimensiones** a partir de los movimientos contables almacenados en MySQL/MariaDB.

El proceso "batch" recalcula saldos por periodos (mensuales) en orden ascendente partiendo de la fecha indicada, mientras que el proceso "incremental" recibe eventos por **RabbitMQ** y aplica **deltas** sobre los saldos ya existentes sin necesidad de reprocesar periodos completos. La combinación permite recalcular históricos completos o absorber altas/bajas/modificaciones de movimientos en tiempo casi-real.

Casos de uso típicos:

- **Reprocesamiento mensual de saldos**: al cierre de mes, se lanza un proceso batch desde una fecha.
- **Actualización incremental**: el sistema externo (origen de los movimientos contables) publica eventos `MovimientoContableEvent` (creados o borrados) en RabbitMQ; esta API los aplica a los saldos.
- **Apertura de nuevos periodos**: el operador o el scheduler automático (`periodo`) crea el periodo siguiente copiando los saldos iniciales desde el periodo anterior.

---

## 2. Arquitectura

La aplicación es un **único proceso Node.js** que ofrece:

1. **API REST** en Fastify (puerto por defecto `3000`) para:
   - salud (`/health*`),
   - procesamiento batch de saldos (`/api/v1/saldos/*`),
   - gestión de periodos (`/api/v1/periodos/*`),
   - documentaciónOpenAPI/Swagger UI (`/documentation`).
2. **Consumidor RabbitMQ** opcional para absorber eventos incrementales.
3. **Schedulers** basados en `node-cron`:
   - creación automática de periodos,
   - purga periódica de `processed_events`.
4. **Persistencia de Jobs** local en archivo JSON (con fallback en memoria).

```text
                        ┌──────────────────────────────────────────┐
                        │              saldos-node (TS)            │
   HTTP (clientes) ───► │  Fastify API  ───┬──► JobService (JSON)  │
                        │                  │                       │
                        │                  ├──► Prisma (MySQL)     │
                        │                  │                       │
                        │                  └──► Schedulers (cron)  │
                        │                          │               │
                        │  RabbitMQConsumer ◄──────┘               │
                        └──────────────────┬───────────────────────┘
                                           │
                  amqp  ◄────── MovimientoContableEvent
                  (publisher externo)
```

Capas internas (`src/`):

```text
src/
├── api/                          # Borde HTTP y adaptadores externos
│   ├── server.ts                 # Arranque Fastify, decoradores, CORS, Swagger, onClose
│   ├── config.ts                 # Carga config.json y aplica env-overrides
│   ├── routes/                   # Rutas HTTP
│   │   ├── health.ts             # /health, /health/detailed, /health/metrics
│   │   ├── saldos.ts             # /api/v1/saldos/preview|procesar|status|jobs|cancel
│   │   └── periodos.ts           # /api/v1/periodos, /status/:jobId
│   ├── plugins/
│   │   └── auth.ts               # Hook onRequest: valida X-API-Key (excepto /health, /documentation)
│   ├── services/                 # JobService, InMemory, FileBacked y factory
│   ├── rabbitmq/                 # RabbitMQConsumer + MessageProcessor (idempotencia opcional)
│   └── scheduler/                # PeriodoScheduler, PurgeProcessedEventsScheduler
│
├── application/
│   ├── useCases/
│   │   ├── ProcesarSaldosContablesUseCase.ts   # Cálculo batch por periodos (clave 9D)
│   │   └── CreatePeriodoUseCase.ts            # Alta de periodo (copia saldos previos)
│   ├── abstractions/                          # Interfaces de repositorios
│   └── contracts/                             # Tipos/DTOs y schemas Zod
│
├── domain/
│   ├── entities/                             # MovimientoContable, MovimientoContableCuenta, SaldoContable
│   └── types/                                # SaldoAggregationKey, SaldoBaseKey, etc.
│
├── infrastructure/
│   └── persistence/                          # PrismaService + repositorios concretos
│
├── main.ts                                    # Bootstrap (start())
└── types/node-cron.d.ts                       # Shim de tipos

prisma/
└── schema.prisma                              # Modelo de datos (MovimientoContable, SaldoContable, etc.)

scripts/
├── generateApiKey.ts                          # Helper que añade un X-API-Key a config.json
├── buildMovimientoEvent.ts                    # Construye payload desde BD
├── publishMovimientoEvent.ts                  # Publica el payload en RabbitMQ
└── benchmarkBulkUpdate.ts                     # Benchmark de bulkUpdate

k8s/
├── deployment.yaml                            # Deployment (replicas=2, probes, env)
├── service.yaml                               # ClusterIP
├── ingress.yaml                               # Ingress + TLS
├── configmap.yaml                             # ConfigMap (¡ojo: declarado por envFrom, ver §18)
└── secret.yaml                                # DATABASE_URL, API_KEY

__tests__/                                     # vitest (unit + integración con Fastify.inject)
```

---

## 3. Stack tecnológico y dependencias

### 3.1 Runtime

- **Node.js 22.x** (LTS en Dockerfile `node:22-alpine`).
- **MySQL/MariaDB** ≥ 8.0 / 10.x. Prisma usa `provider = "mysql"`.

### 3.2 Dependencias de producción (`package.json`)

| Paquete | Versión | Propósito |
|---|---|---|
| `fastify` | ^5.0.0 | HTTP server, schema-driven con `@fastify/swagger`. |
| `@fastify/cors` | ^10.0.0 | CORS abierto en este proyecto (`origin: true`). |
| `@fastify/swagger` | ^9.0.0 | OpenAPI 3. |
| `@fastify/swagger-ui` | ^5.2.6 | UI en `/documentation`. |
| `@fastify/static` | ^8.0.0 | Necesaria por swagger-ui. |
| `@fastify/type-provider-json-schema-to-ts` | ^4.0.0 | Tipado de schemas declarados en el route `schema:`. |
| `@prisma/client` | ^6.0.0 | ORM para MySQL/MariaDB. |
| `amqplib` | ^0.10.9 | Cliente AMQP para RabbitMQ (consumidor). |
| `node-cron` | ^3.0.3 | Expresiones cron estilo POSIX para schedulers. |
| `pino` | ^9.0.0 | Logger estructurado JSON. |
| `pino-http` | ^10.0.0 | Accesorios pino-http (instalado pero el server usa `pino` directo). |
| `pino-roll` | ^2.0.0 | Transporte rolling-file de logs. |
| `uuid` | ^10.0.0 | `uuidv4()` para `jobId` y `CorrelationId` auxiliares. |
| `zod` | ^3.23.0 | Validación de payloads HTTP y de mensajes AMQP. |

### 3.3 Dependencias de desarrollo

| Paquete | Versión | Propósito |
|---|---|---|
| `prisma` | ^6.0.0 | CLI de Prisma (`generate`, `migrate`). |
| `tsx` | ^4.0.0 | Ejecutar TypeScript sin paso de build (CLI y dev). |
| `typescript` | ^5.5.0 | Compilador (`tsc`). |
| `vitest` | ^2.0.0 | Test runner (modo `globals: true`). |
| `@vitest/coverage-v8` | 2.1.9 | Cobertura con motor v8. |
| `supertest` | ^7.0.0 | Cliente HTTP de tests instalado pero no usado (se usa `Fastify.inject`). |
| `@types/amqplib`, `@types/node`, `@types/node-cron`, `@types/uuid` | varios | Tipos. |

### 3.4 Restricciones del compilador (`tsconfig.json`)

- `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`.
- `strict: true` + `noUncheckedIndexedAccess: true` + `noUnusedLocals/Parameters: true` + `noImplicitReturns: true`.
- `include: ["src/**/*"]`, `exclude: ["__tests__", "scripts"]`.
  ⚠️ Los tests y los scripts en `scripts/` **no** son chequeados por `tsc`. Para ejecutarlos se usa `tsx`.

### 3.5 Scripts disponibles

| Comando | Efecto |
|---|---|
| `npm ci` | Instalación reproducible desde `package-lock.json`. |
| `npx prisma generate` | Genera el cliente Prisma. **Obligatorio antes del primer arranque.** |
| `npm run build` | `tsc && prisma generate`. Genera `dist/`. |
| `npm start` | Arranque producción vía `tsx src/main.ts` (en Docker se usa `node dist/main.js`). |
| `npm run dev:api` | `tsx watch src/api/server.ts` (hot-reload). |
| `npm run debug:api` | `node --inspect=9229 --enable-source-maps --import tsx src/main.ts`. |
| `npm run setup:api-key` | Añade un API key aleatorio (32 bytes hex) a `config.json`. |
| `npm run bench:bulk-update` | Benchmark del `bulkUpdate` con distintos tamaños/chunks. |
| `npm test` | `vitest run`. |
| `npm run test:coverage` | `vitest run --coverage`. |
| `npm run docker:build` | Construye imagen `saldos-api:latest`. |
| `npm run docker:run` | Ejecuta el contenedor con `--env-file .env`. |

---

## 4. Prerrequisitos de infraestructura

| Componente | Versión / Detalle | Observaciones |
|---|---|---|
| **Node.js** | 22.x | Definido por `Dockerfile`. |
| **MySQL/MariaDB** | 8.0.x / 10.x | La base de datos debe existir y ser accesible. El usuario debe tener permisos DDL+DML sobre las tablas y acceso a funciones `GET_LOCK`/`RELEASE_LOCK` (purga). |
| **RabbitMQ** *(opcional)* | 3.x AMQP 0.9.1 | Sólo si se activa el consumidor de eventos incrementales. |
| **Recursos** | ≥ 256 MiB RAM / 200m CPU por réplica | Configuración solicitada en `k8s/deployment.yaml`. |
| **Disco** | espacio para `logs/saldos-api-*.json` y `logs/jobs-store.json` | Rotación diaria. |

> **Persistencia crítica:** la cola DLQ de RabbitMQ (`<queueName>.dlq`) debe ser durable para no perder mensajes no-procesables.

---

## 5. Modelo de datos (DDL)

El modelo está definido en `prisma/schema.prisma`. Las tablas usan nombres físicos en snake_case. Prisma genera columnas a partir de nombres `camelCase`.

### 5.1 Vista general de tablas

```text
                       ┌──────────────────────────┐
                       │    saldos_contables      │
                       │  (acumulado por 9D+per)  │
                       └────────▲─────────────────┘
                                │ bulkUpdate / updateByKey
                                │
┌─────────────────────┐         │      ┌───────────────────────────┐
│ movimiento_contable │──────┐  │      │ saldos_contables_periodos │
│ (asientos)          │      │  │      │  (catálogo de periodos)   │
└────┬────────────────┘      │  │      └────────▲──────────────────┘
     │ id                    │  │               │
     ▼                       │  │               │ create/copyFromPeriodo
┌───────────────────────────┐│  │               │
│movimiento_contable_cuentas│└──┴───────────────┘
│  (líneas por cuenta)      │
└───────────────────────────┘

     (events AMQP)
          │
          ▼
┌──────────────────────┐
│ processed_events     │  (idempotencia RabbitMQ)
└──────────────────────┘
```

### 5.2 `movimiento_contable`

```sql
CREATE TABLE movimiento_contable (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  consecutivo              INT          NOT NULL DEFAULT 0,
  estado                   VARCHAR(255) NOT NULL DEFAULT 'APROBADO',
  fecha                    DATETIME(0)  NOT NULL,
  comprobante_id           BIGINT UNSIGNED NULL,
  observacion              VARCHAR(255) NULL,
  created_at               TIMESTAMP(0) NULL,
  updated_at               TIMESTAMP(0) NULL,
  librocontable_id         BIGINT UNSIGNED NULL,
  modelo_id                BIGINT NULL,
  modelo                   VARCHAR(255) NULL,
  documento                VARCHAR(255) NULL,
  usuariocreacion_id       BIGINT UNSIGNED NULL,
  usuariomodificacion_id   BIGINT UNSIGNED NULL,
  periodo_id               BIGINT UNSIGNED NULL,
  cerrado                  BOOLEAN     NOT NULL DEFAULT false,
  hashconsecutivo          BIGINT NULL,
  consecutivostado         ENUM('PENDENTE','ASIGNADO') NULL,
  PRIMARY KEY (id),
  INDEX movimiento_contable_fecha_IDX (fecha, periodo_id),
  INDEX movimiento_contable_periodo_id_IDX (periodo_id, id)
);
```

Lectura en esta app:

- Se iteran por `(periodo_id, id)` orden ascendente, en lotes (`getBatchByPeriodo`).
- La agregación de cuentas se hace con `groupBy` sobre `movimiento_contable_cuentas`.

### 5.3 `movimiento_contable_cuentas`

```sql
CREATE TABLE movimiento_contable_cuentas (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  movimientocontable_id BIGINT UNSIGNED NOT NULL,
  cuentacontable_id     BIGINT UNSIGNED NOT NULL,
  tercero_id            BIGINT UNSIGNED NULL,
  centrocosto_id        BIGINT UNSIGNED NULL,
  base                  DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  debito                DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  credito               DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  observacion           VARCHAR(255) NULL,
  created_at            TIMESTAMP(0) NULL,
  updated_at            TIMESTAMP(0) NULL,
  librocontable_id      BIGINT UNSIGNED NULL,
  unidadnegocio_id      BIGINT UNSIGNED NULL,
  trm                   DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
  factorconversion      DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
  centrooperacion_id    BIGINT UNSIGNED NULL,
  categorizacion_id     BIGINT UNSIGNED NULL,
  modelocartera_id      BIGINT NULL,
  modelocartera         VARCHAR(255) NULL,
  conceptotributario_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  INDEX movimiento_contable_cuentas_movimientocontable_id_IDX (movimientocontable_id)
);
```

Análisis del algoritmo:

- La clave lógica de agrupación (9 dimensiones) usada por esta app es:

  ```text
  (PeriodoId, TerceroId?, CuentaContableId, CentroCostoId?,
   LibroContableId?, UnidadNegocioId?, CentroOperacionId?,
   CategorizacionId?, ModeloCarteraId?, ConceptoTributarioId?)
  ```

  En el código se usa una representación `string` derivada de la combinación pipe-separated, donde los `null/undefined` se serializan como literal `"null"`.

### 5.4 `saldos_contables_periodos`

```sql
CREATE TABLE saldos_contables_periodos (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nombre                   VARCHAR(255) NOT NULL,           -- único lógico (YYYYMM o libre)
  periodoinicio            DATE NULL,
  periodofin               DATE NULL,
  cierre                   BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMP(0) NULL,
  updated_at               TIMESTAMP(0) NULL,
  usuariocreacion_id       BIGINT UNSIGNED NULL,
  usuariomodificacion_id   BIGINT UNSIGNED NULL,
  recalculologico          BOOLEAN NOT NULL,
  cierreanio               BOOLEAN NOT NULL DEFAULT false,
  cierrecontable           BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  INDEX saldos_contables_periodos_nombre_index (nombre),
  INDEX saldos_contables_periodos_usuariocreacion_id_foreign (usuariocreacion_id),
  INDEX saldos_contables_periodos_usuariomodificacion_id_foreign (usuariomodificacion_id)
);
```

Reglas:

- El orden de procesamiento es por `nombre ASC` (no por `id`).
- `periodoinicio` se compara con el `fechaDesde` recibido para filtrar periodos desde esa fecha (>=).
- En la creación de un nuevo periodo (POST `/api/v1/periodos`):
  - El nombre se calcula como `YYYYMM` (e.g., `202608`).
  - `periodoinicio` = día 1 del mes a las `00:00:00.000 UTC`.
  - `periodofin` = último día del mes a las `23:59:59.999 UTC`.
  - `cierre=false`, `cierreanio=false`, `recalculologico=false`.

### 5.5 `saldos_contables`

```sql
CREATE TABLE saldos_contables (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  periodo_id            BIGINT UNSIGNED NOT NULL,
  class                 VARCHAR(255) NULL,
  entidad_id            BIGINT NULL,
  tercero_id            BIGINT UNSIGNED NULL,
  cuentacontable_id     BIGINT UNSIGNED NULL,
  centrocosto_id        BIGINT UNSIGNED NULL,
  saldoinicialdebito    DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  saldoinicialcredito   DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  debito                DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  credito               DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  saldofinaldebito      DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  saldofinalcredito     DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  created_at            TIMESTAMP(0) NULL,
  updated_at            TIMESTAMP(0) NULL,
  librocontable_id      BIGINT UNSIGNED NULL,
  unidadnegocio_id      BIGINT UNSIGNED NULL,
  centrooperacion_id    BIGINT UNSIGNED NULL,
  categorizacion_id     BIGINT UNSIGNED NULL,
  cierre                BOOLEAN NOT NULL DEFAULT false,
  modelocartera_id      BIGINT NULL,
  modelocartera         VARCHAR(255) NULL,
  conceptotributario_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  INDEX saldos_contables_periodo_id_IDX (periodo_id, tercero_id, cuentacontable_id, centrocosto_id),
  INDEX saldos_contables_dim9_IDX (
    periodo_id, cuentacontable_id, tercero_id, centrocosto_id,
    librocontable_id, unidadnegocio_id, centrooperacion_id,
    categorizacion_id, modelocartera_id
  )
);
```

Fórmulas calculadas:

```
SaldoInicialDebito  = prior?.saldoFinalDebito ??  0
SaldoInicialCredito = prior?.saldoFinalCredito ?? 0
SaldoFinalDebito    = SaldoInicialDebito  + debito
SaldoFinalCredito   = SaldoInicialCredito + credito
```

### 5.6 `processed_events`

```sql
CREATE TABLE processed_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  correlation_id  VARCHAR(100) NOT NULL,           -- UNIQUE para idempotencia
  movimiento_id   BIGINT UNSIGNED NULL,
  periodo_id      BIGINT UNSIGNED NOT NULL,
  estado          VARCHAR(20) NOT NULL,            -- 'processing' | 'completed'
  error           TEXT NULL,
  payload_hash    CHAR(64) NULL,                   -- SHA-256 hex del payload
  created_at      TIMESTAMP(0) NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP(0) NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_processed_events_correlation_id (correlation_id),
  INDEX processed_events_periodo_id_IDX (periodo_id)
);
```

Esta tabla es **automática para creado de eventos idempotentes**. Cuando `RABBITMQ__IdempotencyEnabled=true`, cada evento entrante:

1. `INSERT` con `estado='processing'`.
2. Procesamiento.
3. `UPDATE estado='completed'`.
4. Si el `INSERT` viola la `UNIQUE` por `correlation_id` (Prisma `P2002`), el evento es tratado como duplicado y se hace ACK sin reprocesar.

### 5.7 `enum movimiento_contable_consecutivoestado`

```sql
ENUM('PENDENTE', 'ASIGNADO')
```

### 5.8 Consideraciones operativas

- Las tablas **no** tienen FK explícitas en el schema; las relaciones son lógicas a nivel aplicación.
- Los índices están optimizados para dos patrones:
  - Listado por periodo (`(periodo_id, tercero_id, ...)`, `(periodo_id, id)`).
  - Clave completa de 9 dimensiones (`saldos_contables_dim9_IDX`).
- El cálculo se hace en memoria; los valores monetarios se almacenan como `DECIMAL(18,2)` para saldos y `DECIMAL(18,6)` para `trm`/`factorconversion`.

---

## 6. Instalación local paso a paso

### 6.1 Clonar y preparar

```bash
git clone <repo-url> saldos-node
cd saldos-node
cp config.json config.json.local   # nunca subir secretos al repo
```

### 6.2 Editar `config.json`

Modifica la cadena de conexión para apuntar a tu MySQL/MariaDB local:

```jsonc
{
  "connectionString": { "mariaDb": "mysql://root:secret@127.0.0.1:3306/cuentas" },
  "apiKeys": { "allowedKeys": [] },                // [] => modo "acepta cualquier X-API-Key"
  "procesamientoMovimientos": {
    "fechaDesdeDefault": "2000-01-01",
    "batchSizeDefault": 5000
  },
  "logging": {
    "level": "info",
    "filePath": "logs/saldos-api-.json",
    "rollingInterval": "day"
  },
  "server": { "port": 3000, "host": "0.0.0.0" }
}
```

### 6.3 Instalar dependencias y generar Prisma

```bash
npm ci
npx prisma generate
```

⚠️ Si no ejecutas `prisma generate`, el primer arranque fallará con errores tipo `Cannot find module '@prisma/client'`.

### 6.4 Cargar la base de datos (no en alcance del repo)

El proyecto **no incluye migraciones automáticas** (`prisma/migrations/` está excluido en `.gitignore` y el comando `prisma migrate dev` no es parte del flujo habitual). La base de datos debe existir y tener las tablas definidas según el schema (ver §5). Opciones:

- Aplicar manualmente el DDL de §5.
- O usar Prisma con un proyecto externo que provea migración.

### 6.5 Generar API key (recomendado)

```bash
npm run setup:api-key
```

Esto añade una clave aleatoria de 32 bytes hex al `apiKeys.allowedKeys` del `config.json` actual y la imprime por consola.

### 6.6 Arrancar el servicio

Desarrollo con hot-reload:

```bash
npm run dev:api
```

Producción:

```bash
npm run build
npm start
```

La API queda escuchando en `http://0.0.0.0:3000`. Si la conexión a BD falla al arrancar, el servicio **no** aborta: loggea warning y las rutas que dependen de BD devolverán 503 (ver §15).

### 6.7 Probar que está vivo

```bash
curl http://localhost:3000/health
curl http://localhost:3000/health/detailed
```

---

## 7. Configuración

### 7.1 `config.json` (raíz)

| Sección / Propiedad | Tipo | Default (en código) | Descripción |
|---|---|---|---|
| `connectionString.mariaDb` | string | `mysql://root:pass@127.0.0.1:3306/cuentas` | URI MySQL/MariaDB. |
| `apiKeys.allowedKeys` | string[] | `[]` | Lista de API keys válidas. **Vacío = cualquier valor aceptado** (modo dev). |
| `procesamientoMovimientos.fechaDesdeDefault` | string | `2000-01-01` | Fecha mínima por defecto si no se envía `fechaDesde` (no usada actualmente por las rutas; queda como referencia). |
| `procesamientoMovimientos.batchSizeDefault` | number | `1000` | Tamaño de lote por defecto si no se envía `batchSize` (las rutas usan `config?.procesamientoMovimientos.batchSizeDefault`). |
| `logging.level` | string | `info` | Nivel de log (`debug`, `info`, `warn`, `error`). |
| `logging.filePath` | string | `logs/saldos-api-.json` | Archivo rolling (con `pino-roll`). Vacío/omitido desactiva archivo y deja logs en stdout. |
| `logging.rollingInterval` | string | `day` | `day` ⇒ tamaño `1d`; otros ⇒ `1M`. |
| `server.port` | number | `3000` | Puerto Fastify. |
| `server.host` | string | `0.0.0.0` | Interfaz de escucha. |
| `rabbitmq.host` | string | `amqp://localhost` | URI AMQP. |
| `rabbitmq.queueName` | string | `saldos_movimientos` | Cola principal (consumida). |
| `rabbitmq.prefetch` | number | `1` | Mensajes en vuelo simultáneos. |
| `rabbitmq.retryAttempts` | number | `3` | Reintentos antes de DLQ. |
| `rabbitmq.retryDelayMs` | number | `5000` | Base del backoff exponencial: `delay = retryDelayMs * 2^retry`. |
| `rabbitmq.idempotencyEnabled` | boolean | `false` | Habilita tabla `processed_events` (P2002 ⇒ duplicado ⇒ ACK). |
| `rabbitmq.processedEvents.enabled` | boolean | `true` | Habilita scheduler de purga. |
| `rabbitmq.processedEvents.retentionDays` | number | `90` | Días que permanecen `estado='completed'`. |
| `rabbitmq.processedEvents.purgeCron` | string | `30 3 * * *` | Expresión cron para la purga. |
| `rabbitmq.processedEvents.chunkSize` | number | `5000` | Tamaño de lote en `DELETE`. |
| `rabbitmq.processedEvents.stuckHours` | number | `24` | Horas tras las que un `estado='processing'` se considera atascado y se borra. |
| `rabbitmq.processedEvents.optimizeAfterDeletes` | number | `100000` | Si se eliminan ≥ este total, ejecuta `OPTIMIZE TABLE processed_events`. |
| `scheduler.createPeriodoCron` | string | `30 0 1 * *` | Cron para crear el siguiente periodo automáticamente. |

### 7.2 Variables de entorno

Las variables de entorno **sobrescriben** los valores de `config.json`. El nombre usa `__` como separador de niveles (convención `ASP.NET`-style).

#### 7.2.1 Generales

| Variable | Override de | Default | Notas |
|---|---|---|---|
| `ConnectionStrings__MariaDb` | `connectionString.mariaDb` | valor de config.json | Usada por `PrismaService` y `loadConfig`. |
| `Server__Port` | `server.port` | valor de config.json | Si no es entero válido, se usa el fallback. |
| `Server__Host` | `server.host` | valor de config.json | — |
| `DATABASE_URL` | (específico Prisma) | derivado | Si está, Prisma la usa con `datasources.db.url`. |

#### 7.2.2 RabbitMQ

| Variable | Override de |
|---|---|
| `RABBITMQ__Host` | `rabbitmq.host` |
| `RABBITMQ__QueueName` | `rabbitmq.queueName` |
| `RABBITMQ__Prefetch` | `rabbitmq.prefetch` |
| `RABBITMQ__RetryAttempts` | `rabbitmq.retryAttempts` |
| `RABBITMQ__RetryDelayMs` | `rabbitmq.retryDelayMs` |
| `RABBITMQ__IdempotencyEnabled` | `rabbitmq.idempotencyEnabled` (`true`/`false`) |

#### 7.2.3 Purga de eventos procesados

| Variable | Override de |
|---|---|
| `RABBITMQ__ProcessedEvents__Enabled` | `rabbitmq.processedEvents.enabled` |
| `RABBITMQ__ProcessedEvents__RetentionDays` | `…retentionDays` |
| `RABBITMQ__ProcessedEvents__PurgeCron` | `…purgeCron` |
| `RABBITMQ__ProcessedEvents__ChunkSize` | `…chunkSize` |
| `RABBITMQ__ProcessedEvents__StuckHours` | `…stuckHours` |
| `RABBITMQ__ProcessedEvents__OptimizeAfterDeletes` | `…optimizeAfterDeletes` |

#### 7.2.4 Scheduler

| Variable | Override de |
|---|---|
| `SCHEDULER__CreatePeriodoCron` | `scheduler.createPeriodoCron` |

#### 7.2.5 Misceláneos

| Variable | Uso | Default |
|---|---|---|
| `SALDOS_JOB_STORE_PATH` | Ruta de `jobs-store.json` (JobService persistente) | `logs/jobs-store.json` |
| `SALDOS_BULK_UPDATE_CHUNK_SIZE` | Tamaño de chunk para `UPDATE ... CASE WHEN id THEN ...` en `bulkUpdate` | `500` |
| `SALDOS_PROGRESS_PERCENT_STEP` | % mínimo entre logs de avance en cálculo de saldos | `5` |
| `SALDOS_BATCH_LOG_STEP` | Cada cuántos batches se loguea avance en cada periodo | `10` |
| `LOG_LEVEL` (sólo `scripts/benchmarkBulkUpdate.ts`) | Nivel pino del benchmark | `info` |

### 7.3 Resolución de `DATABASE_URL`

`PrismaService.resolveDatabaseUrl()` aplica la siguiente cascada:

```text
process.env.DATABASE_URL
      └─ si undefined → process.env.ConnectionStrings__MariaDb
                              └─ si undefined → connectionString.mariaDb del config.json
```

El valor resuelto se asigna a `process.env.DATABASE_URL` y a `PrismaClient.datasources.db.url` simultáneamente.

---

## 8. Modelo de Jobs y máquina de estados

Las operaciones batch y de creación de periodo son **asíncronas**: el endpoint devuelve `202` con un `jobId` y el trabajo se ejecuta en background. El estado y el progreso se consultan por polling.

### 8.1 Estados

```text
                              ┌─────────┐
                              │ pending │──┐
                              └────┬────┘  │ fallo de ejecución
                                   │       ▼
                                   │   ┌──────┐
                                   ▼   │failed│
                              ┌────────────┐
                              │ processing │──┬──► canceled (por usuario vía POST cancel)
                              └──────┬─────┘  │
                                     │ éxito  │
                                     ▼        │
                                 ┌───────────┐
                                 │ completed │
                                 └───────────┘
```

| Estado | Significado |
|---|---|
| `pending` | Job creado, aún no arrancó. |
| `processing` | Job en ejecución activa (cálculo batch o creación de periodo en background). |
| `completed` | Finalizó con éxito. |
| `failed` | Explotó con error. `error` contiene la causa. |
| `canceled` | Cancelado por `POST /api/v1/periodos/cancel/:jobId` o por `POST /api/v1/saldos/cancel/:jobId`. |

### 8.2 Persistencia

El `JobService` se selecciona en `createJobService()`:

1. Intenta `FileBackedJobService(resolveStorePath(), 1000)`. Lee el archivo al construir.
2. Si el `try/catch` falla, retorna `InMemoryJobService`.

`FileBackedJobService`:

- Almacena todos los jobs en un JSON (un array).
- Tras cada `createJob`/`updateJob` ejecuta `persist()` (escritura completa).
- Límite: 1.000 jobs. Excedido: elimina los más antiguos por `createdAt`.
- `cleanup(24h)` automático vía timer en cada `registerSaldosRoutes`/`registerPeriodosRoutes` (`setInterval` cada hora, `unref`).

`InMemoryJobService`:

- Límite: 100 jobs.
- Sin persistencia; al reiniciar se pierden.

`jobId` tipos:

- Procesamiento de saldos: UUID v4 simple (`uuidv4()`).
- Creación de periodo: `crear-periodo:YYYYMM:UUID`.

### 8.3 Estructura de un `Job` (logging API)

```ts
type Job = {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'canceled';
  fechaDesde: string;              // yyyy-MM-dd o fecha del job de periodo
  batchSize: number;
  periodosProcesados: number;
  movimientosProcesados: number;
  movimientosCuentaProcesados: number;
  tiempoTotalMs: number;
  eta?: string;                    // "1h 12m", "3m 5s", "12s"
  error?: string;
  createdAt: Date;                 // serializado a ISO en disco
  updatedAt: Date;
  resultado?: {
    periodosProcesados: number;
    movimientosProcesados: number;
    movimientosCuentaProcesados: number;
    tiempoTotalMs: number;
    eta?: string;
  };
};
```

### 8.4 Cancelación cooperativa

- `POST /cancel/:jobId` invoca `jobService.updateJob(jobId, { status: 'canceled' })`.
- El use case, dentro de su loop, llama `shouldCancel()`. Si retorna `true` (es decir, status del job == `canceled`), el use case **throwea** `Error('Job cancelado por solicitud del usuario.')` con `name = 'JOB_CANCELED'`, sale con `status='canceled'` y guarda progreso parcial.
- La ruta principal actualiza el job final con `error: 'Cancelado por solicitud del usuario'` o con el mensaje del use case, según quién detectó la cancelación.

---

## 9. Catálogo de endpoints HTTP

### 9.1 Vista general

| # | Método | Ruta | Auth | Categoría | Descripción |
|---|---|---|---|---|---|
| 1 | GET  | `/health` | No | Health | Estado básico. |
| 2 | GET  | `/health/detailed` | No | Health | Estado + DB. |
| 3 | GET  | `/health/metrics` | No | Health | Métricas operativas + estado DB. |
| 4 | POST | `/api/v1/saldos/preview` | Sí | Saldos | Dry-run: lista periodos a procesar. |
| 5 | POST | `/api/v1/saldos/procesar` | Sí | Saldos | Inicia un job asíncrono batch. |
| 6 | GET  | `/api/v1/saldos/status/:jobId` | Sí | Saldos | Estado de un job concreto. |
| 7 | GET  | `/api/v1/saldos/jobs` | Sí | Saldos | Lista jobs (filtros opcionales). |
| 8 | GET  | `/api/v1/saldos/jobs/metrics` | Sí | Saldos | Conteos por estado. |
| 9 | POST | `/api/v1/saldos/cancel/:jobId` | Sí | Saldos | Cancela un job `processing`. |
| 10 | POST | `/api/v1/periodos` | Sí | Periodos | Crea el siguiente periodo contable. |
| 11 | GET  | `/api/v1/periodos/status/:jobId` | Sí | Periodos | Estado del job del periodo. |
| 12 | GET  | `/documentation` | No | Docs | Swagger UI (OpenAPI generado). |
| 13 | GET  | `/documentation/json` | No | Docs | Documento OpenAPI completo en JSON. |

> **Prefijos públicos** (sin requerir `X-API-Key`): `/health`, `/documentation`. El resto requiere autenticación.

### 9.2 Health

#### 9.2.1 `GET /health`

- **Auth:** no requerida.
- **Status esperado:** `200`.
- **Respuesta:**

  ```json
  { "status": "ok", "timestamp": "2026-07-13T10:30:00.000Z" }
  ```

- **Ejemplo `curl`:**

  ```bash
  curl -s http://localhost:3000/health
  ```

#### 9.2.2 `GET /health/detailed`

- **Auth:** no requerida.
- Ejecuta `SELECT 1` sobre Prisma (`app.prismaClient.$queryRaw`).
- **Respuesta cuando DB OK:**

  ```json
  { "status": "ok", "database": "connected", "timestamp": "2026-07-13T10:30:00.000Z" }
  ```

- **Respuesta con DB caída:**

  ```json
  { "status": "ok", "database": "disconnected", "timestamp": "..." }
  ```

- **Sin `prismaClient` decorado:**

  ```json
  { "status": "ok", "database": "not configured", "timestamp": "..." }
  ```

- **Ejemplo:**

  ```bash
  curl -s http://localhost:3000/health/detailed
  ```

#### 9.2.3 `GET /health/metrics`

- **Auth:** no requerida.
- Iguales consideraciones a `/health/detailed`, pero sin el campo `status`.
- **Respuesta DB OK:**

  ```json
  { "timestamp": "2026-07-13T10:30:00.000Z", "database": "connected" }
  ```

### 9.3 Documentación

#### 9.3.1 `GET /documentation`

- UI Swagger interactiva con todos los endpoints y los schemas OpenAPI declarados en cada route.
- **Ejemplo:**

  ```text
  http://localhost:3000/documentation
  ```

#### 9.3.2 `GET /documentation/json`

- Devuelve el OpenAPI serializado (útil para generación de clientes o Postman).

### 9.4 Saldos

#### 9.4.1 `POST /api/v1/saldos/preview`

- **Auth:** `X-API-Key`.
- **Body (JSON):**

  | Campo | Tipo | Requerido | Validación | Descripción |
  |---|---|---|---|---|
  | `fechaDesde` | string | sí | `^\d{4}-\d{2}-\d{2}$` | Fecha inicial. |
  | `batchSize` | number | no | entero positivo | Se recorta al rango `[1000, 10000]`. Si falta, usa `config.procesamientoMovimientos.batchSizeDefault ?? 1000`. |

- **Ejemplo de request:**

  ```bash
  curl -X POST http://localhost:3000/api/v1/saldos/preview \
    -H "Content-Type: application/json" \
    -H "X-API-Key: 1234567890abcdef" \
    -d '{"fechaDesde":"2024-01-01","batchSize":5000}'
  ```

- **Respuesta `200 OK`:**

  ```json
  {
    "fechaDesde": "2024-01-01",
    "batchSize": 5000,
    "periodosCount": 5,
    "periodos": [
      { "id": 10, "nombre": "2024-01" },
      { "id": 20, "nombre": "2024-02" },
      { "id": 30, "nombre": "2024-03" },
      { "id": 40, "nombre": "2024-04" },
      { "id": 50, "nombre": "2024-05" }
    ],
    "mensaje": "Se procesarían 5 períodos con batch size 5000"
  }
  ```

- **Códigos de error:** ver §15.

#### 9.4.2 `POST /api/v1/saldos/procesar`

- **Auth:** `X-API-Key`.
- **Body (mismo schema que preview):**

  | Campo | Tipo | Requerido | Descripción |
  |---|---|---|---|
  | `fechaDesde` | string | sí | Fecha inicial en formato `yyyy-MM-dd`. |
  | `batchSize` | number | no | Recortado a `[1000, 10000]`. Si no, usa `batchSizeDefault`. |

- **Ejemplo:**

  ```bash
  curl -X POST http://localhost:3000/api/v1/saldos/procesar \
    -H "Content-Type: application/json" \
    -H "X-API-Key: 1234567890abcdef" \
    -d '{"fechaDesde":"2024-01-01","batchSize":5000}'
  ```

- **Respuesta `202 Accepted`:**

  ```json
  {
    "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "status": "pending",
    "fechaDesde": "2024-01-01",
    "batchSize": 5000
  }
  ```

  > `status` puede llegar ya como `"processing"` si el callback interno de actualización alcanzó a ejecutarse antes del `await reply.code(202).send(...)`.

- **Restricciones operativas:**
  - Solo puede haber **una** job `processing` simultánea (de saldos). Si ya hay una, la respuesta es `409`.
  - Si `app.useCase` no está disponible (por ejemplo, sin decoradores por custom testing), responde `503`.

- **Códigos de error:** ver §15.

#### 9.4.3 `GET /api/v1/saldos/status/:jobId`

- **Auth:** `X-API-Key`.
- **Path param:** `jobId` (UUID).
- **Ejemplo:**

  ```bash
  curl http://localhost:3000/api/v1/saldos/status/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
    -H "X-API-Key: 1234567890abcdef"
  ```

- **Respuesta `200 OK` (un job `processing` típico):**

  ```json
  {
    "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "status": "processing",
    "fechaDesde": "2024-01-01",
    "batchSize": 5000,
    "periodosProcesados": 3,
    "movimientosProcesados": 15000,
    "movimientosCuentaProcesados": 4500,
    "tiempoTotalMs": 12500,
    "eta": "30s",
    "createdAt": "2026-07-13T10:30:00.000Z",
    "updatedAt": "2026-07-13T10:30:12.500Z"
  }
  ```

- **Respuesta `404`:**

  ```json
  { "error": "Job no encontrado", "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
  ```

#### 9.4.4 `GET /api/v1/saldos/jobs`

- **Auth:** `X-API-Key`.
- **Query params:**

  | Param | Tipo | Default | Descripción |
  |---|---|---|---|
  | `status` | string | sin filtro | Uno de: `pending`, `processing`, `completed`, `failed`, `canceled`. |
  | `limit` | string→int | `50` | Máximo de entradas retornadas. |

- **Ejemplos:**

  ```bash
  # Todos los jobs (últimos 50)
  curl -H "X-API-Key: <key>" http://localhost:3000/api/v1/saldos/jobs

  # Solo completados, últimos 20
  curl -H "X-API-Key: <key>" "http://localhost:3000/api/v1/saldos/jobs?status=completed&limit=20"
  ```

- **Respuesta `200 OK`:** array de jobs (estructura §8.3).

#### 9.4.5 `GET /api/v1/saldos/jobs/metrics`

- **Auth:** `X-API-Key`.
- **Ejemplo:**

  ```bash
  curl -H "X-API-Key: <key>" http://localhost:3000/api/v1/saldos/jobs/metrics
  ```

- **Respuesta `200 OK`:**

  ```json
  {
    "total": 15,
    "pending": 0,
    "processing": 1,
    "completed": 12,
    "failed": 2,
    "canceled": 0
  }
  ```

#### 9.4.6 `POST /api/v1/saldos/cancel/:jobId`

- **Auth:** `X-API-Key`.
- **Path param:** `jobId` (UUID).
- **Ejemplo:**

  ```bash
  curl -X POST \
    -H "X-API-Key: <key>" \
    http://localhost:3000/api/v1/saldos/cancel/a1b2c3d4-e5f6-7890-abcd-ef1234567890
  ```

- **Respuesta `202 Accepted` (job estaba `processing`):**

  ```json
  { "jobId": "a1b2c3d4-…", "status": "canceled" }
  ```

- **Respuesta `404`:**

  ```json
  { "error": "Job no encontrado", "jobId": "a1b2c3d4-…" }
  ```

- **Respuesta `409 Conflict` (job no estaba `processing`):**

  ```json
  {
    "jobId": "a1b2c3d4-…",
    "status": "completed",
    "error": "No se pudo cancelar: el job no está en ejecución (estado actual: completed)."
  }
  ```

### 9.5 Periodos

#### 9.5.1 `POST /api/v1/periodos`

- **Auth:** `X-API-Key`.
- **Body:**

  | Campo | Tipo | Requerido | Validación |
  |---|---|---|---|
  | `fecha` | string | sí | `^\d{4}-\d{2}-\d{2}$`. Se interpreta como `T00:00:00.000Z` UTC. |

- **Reglas de negocio (pre-validación, en orden):**
  1. **No debe existir** un job `pending`/`processing` con prefijo `crear-periodo:`.
  2. **No debe existir** un periodo con `nombre == YYYYMM`.
  3. **Debe existir** un periodo anterior (último por `nombre DESC`).
  4. **Debe ser el inmediatamente anterior** (sin gaps). Por ejemplo: si el último es `202412`, el nuevo debe ser `202501`.

- **Ejemplo:**

  ```bash
  curl -X POST http://localhost:3000/api/v1/periodos \
    -H "Content-Type: application/json" \
    -H "X-API-Key: 1234567890abcdef" \
    -d '{"fecha":"2025-01-01"}'
  ```

- **Respuesta `202 Accepted`:**

  ```json
  {
    "jobId": "crear-periodo:202501:a1b2c3d4-…",
    "status": "pending",
    "fecha": "2025-01-01T00:00:00.000Z"
  }
  ```

- **Códigos de error:** ver §15.

#### 9.5.2 `GET /api/v1/periodos/status/:jobId`

- **Auth:** `X-API-Key`.
- **Path param:** `jobId`. Es el devuelto por `POST /api/v1/periodos`.
- **Ejemplo:**

  ```bash
  curl -H "X-API-Key: <key>" \
    http://localhost:3000/api/v1/periodos/status/crear-periodo:202501:a1b2c3d4-…
  ```

- **Respuesta `200 OK`:** estructura `Job` (igual que jobs de saldos), con `resultado` poblado al `completed`.

- **Respuesta `404`:**

  ```json
  { "error": "Job no encontrado", "jobId": "crear-periodo:…" }
  ```

### 9.6 Swagger UI

`/documentation` carga el UI de Swagger a partir de los `schema:` declarados en cada `route` de Fastify. Los try-it funcionan directamente contra el host de swagger (`/`).

---

## 10. Mecanismo de autenticación y autorización

### 10.1 Tipo de autenticación

API Key estática en header HTTP. **No hay JWT, OAuth ni scopes**: la `X-API-Key` debe pertenecer al whitelist `apiKeys.allowedKeys` (en `config.json` o env equivalente).

### 10.2 Implementación

El plugin `src/api/plugins/auth.ts`:

```ts
app.addHook('onRequest', async (request, reply) => {
  if (publicPrefixes.some(p => request.url.startsWith(p))) return;

  const apiKey = request.headers['x-api-key'];
  if (!apiKey) return reply.status(401).send({ error: 'API key requerida', message: '…' });

  const validKeys = config.apiKeys.allowedKeys;
  if (validKeys.length > 0 && !validKeys.includes(apiKey)) {
    return reply.status(401).send({ error: 'API key inválida' });
  }
});
```

- `onRequest` hook → se ejecuta antes de cualquier handler.
- `publicPrefixes = ['/health', '/documentation']` → `/health/detailed`, `/health/metrics`, `/documentation/json` quedan abiertos por prefijo.

### 10.3 Generación y rotación

```bash
npm run setup:api-key
```

Esto:

- Lee `config.json` actual.
- Si no existe `apiKeys.allowedKeys` o no es array, lo crea con `[]`.
- Genera un `randomBytes(32).toString('hex')` (64 caracteres hex).
- Lo **añade** al final del array.
- Sobrescribe el archivo con el JSON actualizado.
- Imprime por consola la nueva key y el total.

> Para producción: **no** commitear `config.json` con credenciales. Usar ConfigMap/Secret montado como archivo o env-overrides (ver §18).

### 10.4 Flujo completo de una llamada autenticada

```text
Cliente                      Fastify                   Auth Hook                     Handler
   │                            │                          │                           │
   │  POST /api/v1/saldos/x     │                          │                           │
   │  X-API-Key: abc123…        │                          │                           │
   │  Content-Type: …           │                          │                           │
   ├───────────────────────────►│                          │                           │
   │                            │  onRequest hook          │                           │
   │                            ├─────────────────────────►│                           │
   │                            │                          │ url.startsWith('/health') │
   │                            │                          │ o '/documentation'?       │
   │                            │                          │                           │
   │                            │                          │  NO                       │
   │                            │                          │                           │
   │                            │                          │ apiKey header presente?   │
   │                            │                          │                           │
   │                            │                          │ NO → 401 API key requerida│
   │                            │◄─────────────────────────┤                           │
   │                            │  (return early)          │                           │
   │                            │                          │                           │
   │                            │                          │ cargar config.apiKeys.    │
   │                            │                          │ allowedKeys               │
   │                            │                          │                           │
   │                            │                          │ allowedKeys.length == 0?  │
   │                            │                          │  → modo abierto (dev)     │
   │                            │                          │                           │
   │                            │                          │ apiKey ∈ allowedKeys?     │
   │                            │                          │                           │
   │                            │                          │  NO → 401 API key inválida│
   │                            │◄─────────────────────────┤                           │
   │  ◄── 401 ──────────────────┤                          │                           │
   │                            │                          │                           │
   │                            │                          │  SÍ                       │
   │                            │                          ├──────────────────────────►│
   │                            │                          │                           │
   │                            │                          │                           │ handler ejecuta …
   │                            │                          │                           │
   │  ◄── 200/202/4xx/5xx ──────┤◄─────────────────────────┼───────────────────────────┤
   │                            │                          │                           │
```

### 10.5 Modo "abierto" (peligro en producción)

Si `apiKeys.allowedKeys = []` (array vacío), la app acepta **cualquier** valor en `X-API-Key`, incluidos `undefined` o vacío (¡el hook retorna `401` antes si no hay header!). Por tanto, **un atacante que conozca la URL puede invocar la API sin necesidad de conocer la key**. En producción debe poblarse explícitamente.

### 10.6 Cabeceras relevantes en la respuesta

- OpenAPI: la API define `securitySchemes.apiKey` (header `x-api-key`) y todas las secciones excepto Health aplican `security: [{ apiKey: [] }]`.
- Fastify automáticamente responde `401` para bodies no-JSON sin Content-Type (a veces el cliente envía `text/plain`); siempre usar `Content-Type: application/json` para `POST`.

---

## 11. Procesamiento batch (sincrónico, manual)

### 11.1 Flujo general

```text
POST /api/v1/saldos/procesar
        │
        ├─ Zod validation (fechaDesde formato + batchSize positivo)
        ├─ Clamp batchSize a [1000,10000]
        ├─ ¿Hay job processing?  ─SÍ─► 409 con runningJobId
        │                    └──NO─► crear jobId (UUID), job en pending
        ├─ ¿useCase existe?  ─NO─► 503 «Use case no disponible»
        └─ Sí ──► lanzar IIFE async:
                  1. updateJob a processing (allowed: pending|processing)
                  2. useCase.execute(fechaDesde, batchSize, jobId, opts):
                       a. resolvePositiveIntEnv(SALDOS_PROGRESS_PERCENT_STEP, 5)
                       b. resolvePositiveIntEnv(SALDOS_BATCH_LOG_STEP, 10)
                       c. saldoPeriodoRepo.getPeriodosDesdeFechaOrdenados(fechaDesdeDate)
                            ▲ si 0 → throw «No se encontraron periodos…» → status=failed
                       d. para cada periodoId en orden (nombre ASC):
                           - procesarMovimientos(getBatchByPeriodo) → acumular por clave 9D
                           - bulkUpdate cero-inicializa y calcula SaldoFinal
                           - emitProgress(true, eta) si onProgress configurado
                  3. al finalizar:
                       - status='completed' + resultado
                       - status='canceled' si ensureNotCanceled lanzó
                       - status='failed' si cualquier excepción
        │
        └─ responder 202 con jobId, status, fechaDesde, batchSize
```

### 11.2 Algoritmo por periodo

Para cada `periodoId` (filtrados por `periodoinicio >= fechaDesde`, ordenados por `nombre ASC`):

1. **Carga saldos existentes del periodo** (`saldoRepo.getByPeriodo`).
2. **Cero-inicializa** en memoria: `saldoInicialDebito/Credito/Debito/Credito/SaldoFinalDebito/Credito = 0`.
3. Si había saldos previos, ejecuta `bulkUpdate` para persistir el reseteo.
4. **Itera movimientos en lotes de `batchSize`** (vía `getBatchByPeriodo(periodoId, batchSize, lastId)`), usando paginación por cursor implícito (`id > lastId`).
5. Por cada batch:
   - `groupBy` sobre `movimiento_contable_cuentas` por las 9 dimensiones (+ `conceptoTributarioId`), sumando `debito`/`credito`.
   - Acumula en `saldosByKey`.
6. Al terminar todos los batches:
   - Por cada saldo del mapa: `SaldoInicialDebito = prior?.saldoFinalDebito ?? 0`, `SaldoFinalDebito = SaldoInicialDebito + debito` (igual crédito).
   - `bulkUpdate` (con chunks de `SALDOS_BULK_UPDATE_CHUNK_SIZE`) ejecuta un `UPDATE … WHEN id THEN valor` por chunk.

### 11.3 Progreso y ETA

- `useCase` expone `onProgress`. La ruta inyecta:

  ```ts
  onProgress: (p) => updateWhileProcessing(jobId, {
    status: p.status,
    periodosProcesados: p.periodosProcesados,
    movimientosProcesados: p.movimientosProcesados,
    movimientosCuentaProcesados: p.movimientosCuentaProcesados,
    tiempoTotalMs: p.tiempoTotalMs,
    eta: p.eta,
  }, 'progreso'),
  ```

- Se emite cada `progressIntervalMs = 2000` (configurable en la opción al invocar `execute`).
- ETA se forma a partir del promedio por periodo y los restantes.

### 11.4 Cancelación

- `shouldCancel: () => jobService.getJob(jobId)?.status === 'canceled'`.
- El use case llama esta función antes de empezar cada batch y al inicio/final de cada periodo.
- Si retorna `true`, se **throwea** `Error('Job cancelado…')` con `name='JOB_CANCELED'`. La ruta detecta este nombre y reporta `status='canceled'`.
- `updateWhileProcessing` opera con `allowedCurrentStatuses: ['processing']` por defecto, por lo que cambios posteriores a completado/cancelado no sobrescriben el resultado.

### 11.5 Fórmulas y columnas actualizadas

- `saldoinicialdebito`, `saldoinicialcredito`, `debito`, `credito`, `saldofinaldebito`, `saldofinalcredito`, `cierre`, `updated_at`.
- `saldoInicialDebito` y `saldoInicialCredito` son siempre referenciados a `priorSaldo.saldoFinal*` del periodo inmediatamente anterior por `nombre`.
- Si el periodo es el primero de la cadena, se asume `0` en ambos lados.

---

## 12. Procesamiento incremental por RabbitMQ

### 12.1 Topología

| Recurso | Configuración |
|---|---|
| Conexión AMQP | `rabbitmq.host` (default `amqp://localhost`). |
| Cola principal | `rabbitmq.queueName` (`saldos_movimientos`) con `durable: true`, `x-message-ttl = 60000`, `x-dead-letter-exchange = ''` y `x-dead-letter-routing-key = <queueName>.dlq`. |
| Prefetch | `rabbitmq.prefetch` (default `1`). |
| DLQ | `<queueName>.dlq`; las claves inválidas y los reintentos agotados caen aquí. |
| Retry header | `x-retries` (entero). Si no existe, fallback a `redelivered ? 1 : 0`. |
| Backoff | `retryDelayMs * 2^retryCount`; default: 5s, 10s, 20s antes de los 3 reintentos. |

### 12.2 Ciclo de un mensaje

```text
   ┌─────────┐
   │  AMQP   │  (TTL 60s si nadie lo consume)
   └────┬────┘
        ▼
   ┌───────────────────────────────────────────┐
   │ RabbitMQConsumer.processMessage(msg)      │
   │                                           │
   │ 1. JSON.parse del payload                 │
   │ 2. parseAndNormalizeMovimientoEvent (Zod) │
   │    - lanza Error(code='INVALID_EVENT_…')  │
   │      si la validación falla               │
   │ 3. processor.process(event)               │
   │    - dentro de prisma.$transaction:       │
   │      a. processedEvent.createProcessing   │
   │      b. apply deltas periodo a periodo    │
   │      c. processedEvent.markCompleted      │
   │    - si P2002 (UNIQUE correlation_id):    │
   │      → log info + ACK sin reprocesar      │
   │ 4. ACK                                    │
   │                                           │
   │ Si INVALID_EVENT_PAYLOAD:                 │
   │   nack(msg, false, false) → directo a DLQ │
   │ Si otro error:                            │
   │   retryCount < retryAttempts?             │
   │     → nack(requeue=true) tras backoff     │
   │   Sino:                                   │
   │     → nack(requeue=false) → DLQ           │
   └───────────────────────────────────────────┘
```

### 12.3 Algoritmo de aplicación de deltas

- Para cada evento (con periodo `p0 = event.PeriodoId`):
  1. `saldoPeriodoRepo.getPeriodosDesdeIdOrdenados(p0)` → periodos `p0, p1, … pn` ordenados por `nombre ASC`.
  2. Por cada cuenta del evento, se construye una clave 9D con `PeriodoId=p0`. Si `Estado === 'Borrado'`, se aplica **signo -1** a `Debito` y `Credito`.
  3. Se agrupan cuentas con la misma clave 9D en un mismo `delta = { Debito, Credito }`.
  4. Para cada `periodoId` (de `p0` hasta `pn`):
     - En `p0`:
       - Si existe saldo previo, conserva `SaldoInicial` actual. Si no, lo trae del periodo anterior inmediato (`prior?.saldoFinal*`).
       - `Debito += delta.Debito`, `Credito += delta.Credito`.
       - Recalcula `SaldoFinal* = SaldoInicial* + Debito*` para esa clave 9D (en `p0`).
     - En `p1..pn`:
       - `SaldoInicial* = SaldoFinal*` del mismo `delta` en el periodo previo (`finalesPorPeriodo` cache).
       - **No** se modifican `Debito`/`Credito` (esos son movimientos del periodo original).
       - Recalcula `SaldoFinal*`.
  5. `updateByKey(key, values, tx)` es idempotente: si no hay fila, `create` con los mismos valores.

> **Regla práctica**: el delta impacta la `saldoDebito` y `saldoCredito` **sólo** en el periodo del movimiento. La propagación actualiza el resto de periodos llevando el `SaldoFinal` como `SaldoInicial` del siguiente.

### 12.4 Idempotencia

Tabla `processed_events` con `correlation_id UNIQUE`. El `correlation_id` que viaja como propiedad AMQP del mensaje (publisher en `scripts/publishMovimientoEvent.ts` se asegura), se compara contra `event.CorrelationId` del payload y se loggea si difieren.

```text
Evento en cola
   │
   ├─ processedEvent.createProcessing(tx, { correlationId, movimientoId, periodoId, payloadHash })
   │      └─ si P2002 (violación UNIQUE) → log [RABBITMQ] Evento duplicado, ACK sin reprocesar
   │
   ├─ aplicar deltas en transacción
   │
   └─ processedEvent.markCompleted(tx, correlationId)
```

---

## 13. Idempotencia y `processed_events`

Activación:

```json
"rabbitmq": { "idempotencyEnabled": true, "processedEvents": { "enabled": true, "retentionDays": 90, ... } }
```

Variables equivalentes:

```bash
RABBITMQ__IdempotencyEnabled=true
RABBITMQ__ProcessedEvents__Enabled=true
RABBITMQ__ProcessedEvents__RetentionDays=90
```

Operación:

- Habilita `prisma.processedEvent.create` y luego `prisma.processedEvent.update estado='completed'`.
- Si la inserción choca con `UNIQUE correlation_id`, Prisma devuelve `P2002` y el procesador loggea `"[RABBITMQ] Evento duplicado, ACK sin reprocesar"` y termina sin aplicar el delta.
- La purga programada (§14.2) borra entradas `completed` con `created_at < now - retentionDays` y entradas `processing` con `created_at < now - stuckHours`.

---

## 14. Schedulers

### 14.1 `PeriodoScheduler`

- **Propósito:** crear el siguiente periodo contable (reglas idénticas a `POST /api/v1/periodos`).
- **Carga `node-cron` con `createRequire`** para tolerar su ausencia (en cuyo caso solo loggea warning y queda inactivo).
- **Cron:** `scheduler.createPeriodoCron` (default `30 0 1 * *` ⇒ día 1 de cada mes a las 00:30).
- **Comportamiento:** en cada *tick*, construye la fecha del día y verifica:
  - que no exista un job crear-periodo en curso;
  - las reglas de negocio;
  - crea un job con prefijo `crear-periodo:YYYYMM:UUID`, batchSize 0 (no aplica);
  - ejecuta el `CreatePeriodoUseCase.execute(new Date(fechaISO + 'T00:00:00.000Z'))`.

### 14.2 `PurgeProcessedEventsScheduler`

- **Propósito:** eliminar entradas viejas de `processed_events` y hacer `OPTIMIZE TABLE` opcional.
- **Activación:** `rabbitmq.idempotencyEnabled && rabbitmq.processedEvents.enabled`. Ambas deben ser `true`.
- **Mecanismo de concurrencia:** usa `GET_LOCK('processed_events_purge', 0)` con timeout cero; si no obtiene el lock, sale (evita que dos réplicas se pisen).
- **Pasada:**

  ```text
  while (DELETE FROM processed_events WHERE estado='completed' AND created_at < cutoff LIMIT chunk) < chunk:
    …
  while (DELETE FROM processed_events WHERE estado='processing' AND created_at < stuckCutoff LIMIT chunk) < chunk:
    …
  if total_eliminados >= optimizeAfterDeletes:
    OPTIMIZE TABLE processed_events
  RELEASE_LOCK('processed_events_purge')
  ```

- **Cron:** `rabbitmq.processedEvents.purgeCron` (default `30 3 * * *` ⇒ diario 03:30).
- **Logs:** prefijo `[PURGE]`.

---

## 15. Catálogo de errores

### 15.1 Códigos HTTP comunes

| Código | Significado | Forma del cuerpo |
|---|---|---|
| `400` | Validación fallida o regla de negocio | `{ "error": "Validación fallida", "details": [...] }` o con códigos semánticos. |
| `401` | Sin API Key o key inválida | `{ "error": "API key requerida" \| "API key inválida", "message"?: "…" }`. |
| `404` | Recurso inexistente | `{ "error": "Job no encontrado", "jobId": "…" }`. |
| `409` | Conflicto (job activo, periodo duplicado) | `{ "error": "…, "runningJobId"?: "…" }` o `{ code, message, status }`. |
| `500` | Error inesperado | `{ "error": "Error interno", "detail": "…" }`. |
| `503` | Dependencia indisponible (DB, repos, useCase) | `{ "error": "Repos no disponibles" \| "Base de datos no disponible" \| "Use case no disponible" }`. |

### 15.2 Catálogo por endpoint

#### Auth middleware

| Código | Mensaje | Causa | Mitigación |
|---|---|---|---|
| 401 | `{"error":"API key requerida","message":"El header X-API-Key es obligatorio"}` | Falta header `X-API-Key`. | Añadir el header en cada request. |
| 401 | `{"error":"API key inválida"}` | El valor no está en `apiKeys.allowedKeys`. | Usar una key listada; regenerar con `npm run setup:api-key`. |

#### `POST /api/v1/saldos/preview`

| Código | Mensaje | Causa |
|---|---|---|
| 400 | `{"error":"Validación fallida","details":[...]}` | `fechaDesde` no cumple `^\d{4}-\d{2}-\d{2}$` o `batchSize` no es entero positivo. |
| 400 | `{"error":"No se encontraron periodos con periodoInicio >= <fecha>"}` | No hay periodos con `periodoinicio ≥ fechaDesde` en la BD. |
| 500 | `{"error":"Error interno","detail":"…"}` | Excepción inesperada (consulta a BD u otro). |
| 503 | `{"error":"Base de datos no disponible"}` | `app.saldoPeriodoRepo` no está decorado (no se inicializó repositorio). |

#### `POST /api/v1/saldos/procesar`

| Código | Mensaje | Causa |
|---|---|---|
| 400 | `{"error":"Validación fallida","details":[...]}` | Igual que preview. |
| 409 | `{"error":"Ya existe un job en ejecución","runningJobId":"<uuid>"}` | Hay otro job del ámbito `saldos` con `status='processing'`. |
| 500 | `{"error":"Error interno","detail":"…"}` | Excepción no manejada. |
| 503 | `{"error":"Use case no disponible"}` | `app.useCase` no inicializado. |
| (asíncrono) `failed` (al consultar `status/:jobId`) | `error: 'No se encontraron periodos con periodoInicio >= <fecha>'` | Igual motivo que preview, detectado al ejecutar el use case. |

#### `GET /api/v1/saldos/status/:jobId`

| Código | Mensaje | Causa |
|---|---|---|
| 404 | `{"error":"Job no encontrado","jobId":"…"}` | `jobId` no existe en el `JobService` (en memoria o archivo JSON). |

#### `GET /api/v1/saldos/jobs`

| Código | Mensaje | Causa |
|---|---|---|
| 200 | Siempre OK (incluso sin jobs). | — |
| (Zod impl.) `400` | Solo si se envía query con formato no esperado (no implementado estrictamente). |

#### `POST /api/v1/saldos/cancel/:jobId`

| Código | Mensaje | Causa |
|---|---|---|
| 202 | `{"jobId":"…","status":"canceled"}` | Job estaba `processing`, cancelación OK. |
| 404 | `{"error":"Job no encontrado","jobId":"…"}` | No existe el job. |
| 409 | `{"jobId":"…","status":"<otro>","error":"No se pudo cancelar: el job no está en ejecución (estado actual: <otro>)."}` | Job existe pero no está en `processing`. |

#### `POST /api/v1/periodos`

| Código | Mensaje | Causa |
|---|---|---|
| 400 | `{"error":"Validación fallida","details":[...]}` | `fecha` no cumple regex o falta. |
| 400 | `{"code":"SIN_PERIODO_ANTERIOR","message":"No se permite crear el primer periodo"}` | `getUltimoPeriodo()` retorna `null` (tabla vacía). |
| 400 | `{"code":"GAP_NO_PERMITIDO","message":"Se esperaba que el último periodo fuera <YYYYMM>"}` | El último periodo existe pero no es el inmediatamente anterior (hay hueco). |
| 409 | `{"code":"PERIODO_YA_EXISTE","message":"El periodo <YYYYMM> ya existe"}` | `existsByNombre(nombre)===true`. |
| 409 | `{"error":"Ya existe un job de creación de periodo en ejecución","runningJobId":"<jobId>"}` | Hay job `pending|processing` con prefijo `crear-periodo:`. |
| 500 | `{"error":"Error interno"}` | Excepción en la pre-validación. |
| 503 | `{"error":"Repos no disponibles"}` | `app.saldoPeriodoRepo` o `app.saldoRepo` no decorados. |
| (asíncrono) `failed` (al consultar `status/:jobId`) | `error` con uno de los mensajes: `"El periodo YYYYMM ya existe"`, `"No existe periodo anterior a YYYYMM"`, `"El último periodo es X y no es el inmediatamente anterior (Y)"` | Detectado dentro de `CreatePeriodoUseCase.execute` (clases `PeriodoYaExisteError`, `PeriodoSinAnteriorError`, `PeriodoNoInmediatoAnteriorError`). |

#### `GET /api/v1/periodos/status/:jobId`

| Código | Mensaje | Causa |
|---|---|---|
| 404 | `{"error":"Job no encontrado","jobId":"…"}` | Job id no registrado. |

#### Health

| Endpoint | Específico | Causa |
|---|---|---|
| `/health` | 200 siempre | Nunca devuelve error. |
| `/health/detailed`, `/health/metrics` | `database: "connected"` | Resultado OK de `SELECT 1`. |
| | `database: "disconnected"` | Excepción al ejecutar `SELECT 1`. |
| | `database: "not configured"` | `app.prismaClient` no decorado (no se inicializó Prisma). |

### 15.3 Errores en modo RabbitMQ (no son HTTP)

Aparecen en logs (prefijo `[RABBITMQ]`):

| Evento | Log | Acción |
|---|---|---|
| Validación Zod falla | `"[RABBITMQ] Evento inválido. Enviando a DLQ sin reintentos"` | `nack` sin requeue → DLQ. |
| Error de procesamiento con reintentos disponibles | `"[RABBITMQ] Reintentando mensaje"` + `"[RABBITMQ] Error procesando mensaje"` | Backoff y `nack(requeue=true)`. |
| Reintentos agotados | `"[RABBITMQ] Mensaje enviado a DLQ después de reintentos"` | DLQ. |
| Duplicado idempotente | `"[RABBITMQ] Evento duplicado, ACK sin reprocesar"` | ACK sin aplicar delta. |
| Éxito | `"[RABBITMQ] Mensaje ACK"` (incluye `durationMs`). | ACK tras `processor.process`. |

### 15.4 Catálogo completo de clases de error internas

| Clase (TypeScript) | Origen | Mensaje típico |
|---|---|---|
| `PeriodoYaExisteError` | `CreatePeriodoUseCase` | `El periodo YYYYMM ya existe` |
| `PeriodoSinAnteriorError` | `CreatePeriodoUseCase` | `No existe periodo anterior a YYYYMM` |
| `PeriodoNoInmediatoAnteriorError` | `CreatePeriodoUseCase` | `El último periodo es X y no es el inmediatamente anterior (Y)` |
| Error en `ProcesarSaldosContablesUseCase` (sin periodo válido) | `ProcesarSaldosContablesUseCase` | `No se encontraron periodos con periodoInicio >= YYYY-MM-DD` |
| Error con `name='JOB_CANCELED'` | `ProcesarSaldosContablesUseCase` (manual) | `Job cancelado por solicitud del usuario.` |
| `Error code='INVALID_EVENT_PAYLOAD'` | `MovimientoContableEventSchema` | `Evento inválido: <path>: <message>; …` |
| Prisma `P2002` | Cualquier `INSERT/UPDATE` con UNIQUE | `Unique constraint failed on the fields: (correlation_id)` (idempotencia) |
| Prisma connection error | Cualquier query | Texto genérico; el conector Prisma lo expone. |

---

## 16. Catálogo de eventos RabbitMQ

### 16.1 Formato

- `Content-Type: application/json`.
- `Message properties` típicas:
  - `messageId = event.id`.
  - `correlationId = event.CorrelationId`.
  - `type = 'MovimientoContableEvent'`.
  - `deliveryMode = 2` (persistente).
  - `timestamp = <unix-seconds>`.

### 16.2 Schema Zod (`MovimientoContableEventSchema`)

```ts
CuentaSchema = {
  MovimientoContableId: number (int, requerido)
  CuentaContableId: number (int, requerido)
  TerceroId: number | null
  CentroCostoId: number | null
  LibroContableId: number | null
  UnidadNegocioId: number | null
  CentroOperacionId: number | null
  CategorizacionId: number | null
  ModeloCarteraId: number | null
  ModeloCartera: string | null | undefined
  ConceptoTributarioId: number | null | undefined
  Debito: number
  Credito: number
}

MovimientoContableEventSchema = {
  id: number (int)
  fecha: string | Date
  estado: string
  Estado: 'Creado' | 'Borrado'
  CorrelationId: string (min length 1)
  PeriodoId: number (int)
  cuentas: array<CuentaSchema> (min 1)
}
```

`strict()` rechaza cualquier clave extra.

### 16.3 Ejemplo de payload válido

```json
{
  "id": 12345,
  "fecha": "2026-07-20T00:00:00.000Z",
  "estado": "APROBADO",
  "Estado": "Creado",
  "CorrelationId": "e9c6d8b2-3a4b-4d7f-8e6c-77a90c0b2e31",
  "PeriodoId": 100,
  "cuentas": [
    {
      "MovimientoContableId": 12345,
      "CuentaContableId": 4001,
      "TerceroId": 10,
      "CentroCostoId": null,
      "LibroContableId": 1,
      "UnidadNegocioId": 2,
      "CentroOperacionId": null,
      "CategorizacionId": null,
      "ModeloCarteraId": null,
      "ModeloCartera": "Cartera X",
      "ConceptoTributarioId": null,
      "Debito": 1000.00,
      "Credito": 0.00
    },
    {
      "MovimientoContableId": 12345,
      "CuentaContableId": 2900,
      "TerceroId": 10,
      "CentroCostoId": null,
      "LibroContableId": 1,
      "UnidadNegocioId": 2,
      "CentroOperacionId": null,
      "CategorizacionId": null,
      "ModeloCarteraId": null,
      "ModeloCartera": "Cartera X",
      "ConceptoTributarioId": null,
      "Debito": 0.00,
      "Credito": 1000.00
    }
  ]
}
```

### 16.4 Eventos inválidos

Cualquier desviación produce error con `code='INVALID_EVENT_PAYLOAD'` y el mensaje describe la primera inconsistencia. Por ejemplo:

- Falta `CorrelationId` → `"Evento inválido: CorrelationId: String must contain at least 1 character(s)"`.
- `Estado` fuera de enum → `"Evento inválido: Estado: Invalid enum value. Expected 'Creado' | 'Borrado', received 'X'"`.
- `fecha` no parseable → `"Evento inválido: fecha no parseable"`.
- Claves extra → `"Evento inválido: <field>: Unrecognized key"`.
- `cuentas` vacío → `"Evento inválido: cuentas: Array must contain at least 1 element(s)"` (Zod `min(1)`).

---

## 17. Logs y trazabilidad

### 17.1 Componentes

| Componente | Logger | Prefijo de mensaje |
|---|---|---|
| Fastify (HTTP) | Pino con transport `pino-roll` opcional | (pino-http / Fastify logger estándar). |
| `ProcesarSaldosContablesUseCase` | Pino (pasado por constructor) | `[SALDOS]` |
| `RabbitMQConsumer` y `MessageProcessor` | Pino (pasado por constructor) | `[RABBITMQ]` |
| `PeriodoScheduler` | App logger (`app.log`) | `[SCHEDULER]` |
| `PurgeProcessedEventsScheduler` | Pino (interno o pasado) | `[PURGE]` |
| `CreatePeriodoUseCase` ejecuta desde las rutas | `request.log.request` | `[PERIODOS]` |
| `PrismaService` | Pino vía `setPrismaLogger` | `Prisma conectado a la base de datos` / `Error conectando a la base de datos` |

### 17.2 Configuración

- `logging.level` (`info`, `debug`, …) define el piso global.
- `logging.filePath` (e.g., `logs/saldos-api-.json`) activa `pino-roll` con tamaño `1d` (cuando `rollingInterval == 'day'`) o `1M` en otros casos. El directorio `logs/` se crea automáticamente.
- Si `filePath` está vacío, los logs van a stdout (útil en Kubernetes para recolección por el agente).
- Cada log es un JSON con campos: `level`, `time`, `name: 'saldos-api'`, `msg`, propiedades contextuales (jobId, periodoId, error, etc.).

### 17.3 Rutas registradas más relevantes

- Inicio del servidor: `API escuchando { port, host }`.
- Creación de job: `[SALDOS] Iniciando procesamiento { jobId, fechaDesde, effectiveBatchSize }`.
- Avance por periodo: `[SALDOS] Periodo <id> completado { jobId, periodoId, movimientosProcesados, cuentasProcesadas, tiempoMs, promedioMs, eta }`.
- Avance por batch: `[SALDOS] Avance de procesamiento por lotes { periodoId, batchIndex, batchMovimientos, totalPeriodMovimientos, totalPeriodCuentas }`.
- Avance del cálculo: `[SALDOS] Avance de cálculo de saldos { periodoId, procesados, total, porcentaje }` cada `SALDOS_PROGRESS_PERCENT_STEP` (5%).
- Cancelación: `[SALDOS] Procesamiento cancelado { jobId, tiempoTotalMs }`.
- Fallo: `[SALDOS] Error en procesamiento { jobId, error, tiempoTotalMs }` (nivel `error`).
- RabbitMQ recibido: `[RABBITMQ] Mensaje recibido { deliveryTag, redelivered, messageId, correlationId, size }`.
- RabbitMQ procesado: `[RABBITMQ] Mensaje ACK { correlationId, movimientoId, durationMs }`.
- RabbitMQ inválido: `[RABBITMQ] Evento inválido. Enviando a DLQ sin reintentos`.
- RabbitMQ duplicado: `[RABBITMQ] Evento duplicado, ACK sin reprocesar { correlationId }`.
- Periodos: `[PERIODOS] Job creado (pending)`, `[PERIODOS] Job iniciado (processing)`, `[PERIODOS] Job completado { jobId, nombre, saldosCreados, saldosVerificados }`, `Error creando periodo`.
- Scheduler de periodos: `[SCHEDULER] Iniciando scheduler de creación de periodos`, `[SCHEDULER] Job crear-periodo creado (pending)`, `[SCHEDULER] Job crear-periodo completado`, `[SCHEDULER] Error ejecutando job crear-periodo`.
- Purga: `[PURGE] Purga de processed_events completada { totalCompleted, totalStuck, durationMs }`, `[PURGE] Otro proceso tiene el lock. Saliendo.`

### 17.4 Trazabilidad por `jobId`

- Toda referencia a un job (saldo o periodo) lleva `jobId` en el log.
- Para un flujo de un job `processing`:

  ```text
  [SALDOS] Iniciando procesamiento { jobId }
  [SALDOS] Configuración de logs de avance { jobId, progressPercentStep, batchLogStep }
  [SALDOS] Periodos encontrados { jobId, periodosCount }
  [SALDOS] Saldos del periodo inicializados { periodoId, saldosInicializados }
  [SALDOS] Avance de procesamiento por lotes { periodoId, batchIndex, … }
  [SALDOS] Periodo <id> completado { jobId, periodoId, … }
  …
  [SALDOS] Procesamiento completado { jobId, periodosProcesados, … }
  ```

- Cancelación trazable:

  ```text
  [SALDOS] Procesamiento cancelado { jobId, tiempoTotalMs }
  ```

- En `updateWhileProcessing`, si el job ya no está en estado permitido, loggea `warn`: `No se actualiza job porque no está en un estado permitido { jobId, context, currentStatus, allowedCurrentStatuses }`.

### 17.5 Trazabilidad en RabbitMQ

- `messageMeta` se incluye como campo del log: `deliveryTag`, `redelivered`, `exchange`, `routingKey`, `messageId`, `correlationId`, `timestamp`.
- `sanitizeAmqpUrl` oculta la password del host antes de loggear.

---

## 18. Despliegue

### 18.1 Ejecución local

```bash
npm ci
npx prisma generate
# Editar config.json / .env según necesidad
npm run dev:api     # desarrollo
npm run build && npm start   # producción en host (tsx)
```

El servidor escucha en `0.0.0.0:3000` salvo cambio.

### 18.2 Docker (single process)

```bash
# Build
docker build -t saldos-api:latest .

# Run
docker run -p 3000:3000 --env-file .env saldos-api:latest
```

Detalles del `Dockerfile` (multi-stage):

- **Builder (`node:22-alpine`):** `npm ci`, copia del código, `npx prisma generate`, `npm run build`.
- **Runner (`node:22-alpine`):** copia de `dist/`, `node_modules/`, `prisma/`, `config.json`, `scripts/`. Crea grupo y usuario **`appuser:appgroup`**, cambia propietario de artefactos y `logs/`. `WORKDIR /app`. `EXPOSE 3000`. `CMD ["node", "dist/main.js"]`.

> ⚠️ El Dockerfile copia `config.json` al contenedor. En producción **no** se debe confiar en este archivo para credenciales: prefiera env vars obind-mount/secret-mount (§18.3.2).

### 18.3 Kubernetes

#### 18.3.1 Manifiestos provistos (`k8s/`)

| Archivo | Resumen |
|---|---|
| `deployment.yaml` | Deployment con 2 réplicas, `app: saldos`, `component: api`. `envFrom` toma el `ConfigMap saldos-config` y el `Secret saldos-secret`. `env` directo: `ConnectionStrings__MariaDb ← saldos-secret/DATABASE_URL` y `X-API-Key ← saldos-secret/API_KEY`. Probes: liveness a `/health`, readiness a `/health/detailed`. Resources: 256Mi/100m request, 512Mi/500m limit. |
| `service.yaml` | ClusterIP en puerto 80 → `targetPort 3000`. |
| `ingress.yaml` | Ingress nginx, TLS con `secretName: saldos-tls`, host `saldos.example.com` (placeholder). |
| `configmap.yaml` | ConfigMap `saldos-config` con: `config.json` (config completa de no-producción como placeholder) y `NODE_ENV=production`. |
| `secret.yaml` | `saldos-secret` con `DATABASE_URL` y `API_KEY` (placeholders). |

#### 18.3.2 ⚠️ Caveats detectados en los manifiestos

> Importante: estos puntos requieren ajuste antes de pasar a producción.

1. **`ConfigMap saldos-config.config.json` está mal entregado.**
   `envFrom.configMapRef` inserta **cada clave del ConfigMap como variable de entorno** del Pod. Por tanto la app recibirá una variable literal llamada `config.json` cuyo valor es el JSON en texto. La app en cambio **lee el archivo** `config.json` desde disco (`loadConfig()` resuelve `path.resolve(__dirname, '../../config.json')`).
   **Cómo corregir** (elija uno):
   - Sustituir `envFrom` por un `volumeMounts` + `volumes` con `configMap.name: saldos-config` + `items[].key=config.json` y `path=config.json`.
   - O usar `env:` con `valueFrom.configMapKeyRef` por cada propiedad individual que se quiera sobrescribir (no se recomienda; es verboso y rompe con cambios).
   - O usar exclusivamente variables de entorno (recomendado) y eliminar el `ConfigMap` para `config.json`.

2. **`X-API-Key` en env no es leído por la app.**
   El deployment define `env.X-API-Key ← saldos-secret/API_KEY`. La app **no** lee esa variable; las claves válidas deben estar en `apiKeys.allowedKeys` (config.json o env equivalente `apiKeys__allowedKeys`). Sí funciona configurar `ConnectionStrings__MariaDb` (lo lee `loadConfig` directamente). El `X-API-Key` se puede descartar del env o usarlo como referencia humana.

3. **`Secret saldos-secret` con claves placeholder.**
   `DATA: DATABASE_URL: "mysql://root:PASSWORD@mysql:3306/cuentas"`, `API_KEY: "API_KEY_PLACEHOLDER"`. Reemplazar antes de aplicar.

4. **`host` de Ingress** es `saldos.example.com`. Cambiar según dominio real.

5. **Recursos límites sanos pero estáticos.** Si el batch consume mucha RAM, considerar separación (deployments diferenciados para API y workers) o HPA.

#### 18.3.3 Secuencia recomendada de despliegue

1. Crear el namespace y secrets (con `kubectl create secret generic saldos-secret --from-literal=...`).
2. Aplicar ConfigMap corregido (ideal con `volume`).
3. `kubectl apply -f deployment.yaml`.
4. `kubectl apply -f service.yaml`.
5. `kubectl apply -f ingress.yaml` (verificar `secretName: saldos-tls`).

#### 18.3.4 Verificación post-despliegue

```bash
kubectl get pods -l app=saldos
kubectl logs -f deploy/saldos-api | grep "API escuchando"

# Dentro del cluster o vía ingress:
curl -s https://saldos.example.com/health
```

### 18.4 Variables de entorno mínimas para producción

Recomendado:

```text
ConnectionStrings__MariaDb=mysql://USER:PASS@HOST:3306/cuentas
Server__Host=0.0.0.0
Server__Port=3000
RABBITMQ__Host=amqp://USER:PASS@rabbitmq:5672
RABBITMQ__QueueName=saldos_movimientos
RABBITMQ__IdempotencyEnabled=true
RABBITMQ__ProcessedEvents__Enabled=true
RABBITMQ__ProcessedEvents__PurgeCron=30 3 * * *
SALDOS_JOB_STORE_PATH=/var/lib/saldos/jobs-store.json
NODE_ENV=production
```

> Las `apiKeys.allowedKeys` requieren entregarse como archivo `config.json` (vía Secret volumount) **o** como `apiKeys__AllowedKeys__0=…`, `apiKeys__AllowedKeys__1=…` (sólo es válido si se desea usar env-override; el loader no procesa esta variante porque no está implementada en `applyEnvOverrides`). Por tanto la forma soportada hoy es **archivo `config.json`** montado como volume desde un Secret.

---

## 19. Operación, monitoreo y tuning

### 19.1 Señales operativas clave

- `/health/detailed`: latencia de `SELECT 1`. Útil para alerta DB-down.
- `/api/v1/saldos/jobs/metrics`: `processing` debe tender a 0–1; `failed` creciente → alerta.
- `logs`: revisar `[SALDOS] Error en procesamiento`, `[RABBITMQ] Evento inválido. Enviando a DLQ`, `[PURGE] Otro proceso tiene el lock. Saliendo.`.
- `logs/jobs-store.json`: indicador de saturación si se aproxima a 1.000 entradas.
- DLQ en RabbitMQ: cantidad de mensajes debe ser 0 (esperado). Mensajes que caen aquí requieren investigación manual.

### 19.2 Ajuste de rendimiento

| Variable | Cuándo ajustar | Default |
|---|---|---|
| `batchSize` (request) | Más alto = menos round-trips; reduce granularidad del progreso. Cap 10.000. | del cliente |
| `SALDOS_BULK_UPDATE_CHUNK_SIZE` | Subir si el motor de BD tolera `UPDATE` con miles de `CASE`. Bajar si la replica SQL se ahoga. | 500 |
| `SALDOS_BATCH_LOG_STEP` | Subir para reducir volumen de logs en producción. | 10 |
| `SALDOS_PROGRESS_PERCENT_STEP` | Subir para menos detalle. | 5 |
| `RABBITMQ__Prefetch` | Subir para más throughput, pero más memoria y riesgo de re-procesado largo. | 1 |
| `RABBITMQ__RetryAttempts` / `RABBITMQ__RetryDelayMs` | Ajustar al SLA y al comportamiento esperado de fallos transitorios. | 3 / 5000ms |
| Probes k8s | Reducir `initialDelaySeconds` si DB está garantizada en N segundos. | 10–15 s |

### 19.3 Capacidad estimada (ejemplo)

- 100.000 movimientos / periodo, `batchSize=5000` ⇒ ~20 iteraciones por periodo.
- 12 meses en cadena ⇒ ~240 iteraciones + cálculo en memoria.
- En MySQL con índice `(periodo_id, id)`, `bulkUpdate` con chunk 500 suele ejecutar en sub-segundos por chunk.

### 19.4 Reinicio ordenado

`onClose` hook apaga:

- RabbitMQ consumer (cierra channel y connection).
- Schedulers (cron tasks stop).
- Prisma (desconexión limpia).

⇒ En Kubernetes, `terminationGracePeriodSeconds` debe contemplar el tiempo que tarda un job a medio camino en cooperar con la cancelación. Sugerido: 60–120s.

---

## 20. Pruebas (tests)

### 20.1 Framework

- `vitest` con `globals: true` (`vitest.config.ts`).
- Ubicación: `__tests__/`, espejando `src/`.

### 20.2 Cobertura

| Suite | Archivo | Qué prueba |
|---|---|---|
| Domain entities | `__tests__/domain/entities.test.ts` | Tipos de `SaldoContable`, `MovimientoContable`, `MovimientoContableCuenta`. |
| Use case | `__tests__/application/ProcesarSaldosContablesUseCase.test.ts` | Lógica con repos mockeados (filtro por fecha, orden por nombre, casos sin periodos, fallos de conexión). |
| API | `__tests__/api/routes.test.ts` | `Fastify.inject` de health/jobs/preview/procesar/cancel. |
| API | `__tests__/api/periodos.routes.test.ts` | Reglas de negocio (duplicado, sin anterior, gap). |
| API | `__tests__/api/config.test.ts` | Env overrides (`Server__Port`). |
| API | `__tests__/api/JobService.test.ts` | `InMemoryJobService`. |
| API | `__tests__/api/FileBackedJobService.test.ts` | Persistencia y reset al límite. |
| API | `__tests__/api/rabbitmq/MessageProcessor.test.ts` | Deltas Creado/Borrado, propagación entre periodos, omit cuando no hay periodos desde el `PeriodoId` dado. |

### 20.3 Comandos

```bash
npm test                   # suite completa
npm run test:coverage      # con reporte HTML en coverage/
npm run test:watch         # modo watch
```

### 20.4 Buenas prácticas

- Los tests aíslan `SALDOS_JOB_STORE_PATH` usando `os.tmpdir()` para no contaminar el archivo real.
- Los tests `routes.test.ts` y `periodos.routes.test.ts` usan mocks para `useCase.execute()` (a veces una Promise que nunca resuelve para simular job `processing`).
- Los tests de `MessageProcessor` validan el contrato de la actualización multiperiodo: en `pi>0` no se pasan `Debito`/`Credito` en `values`.

---

## 21. Troubleshooting

### 21.1 Problemas frecuentes

| Síntoma | Causa probable | Verificación / Fix |
|---|---|---|
| `Cannot find module '@prisma/client'` | No se ejecutó `prisma generate`. | `npx prisma generate` antes de cualquier arranque. |
| `404 Job no encontrado` al consultar status | El job está en el otro store (memoria vs archivo) o se purgó (>24h). | Verificar `SALDOS_JOB_STORE_PATH`, rotation, restart. |
| `409 Ya existe un job en ejecución` permanente | Job anterior quedó en `processing` por crash y nunca avanzó. | Reiniciar el pod; el archivo persiste el estado. Considerar expiration. |
| `503 Base de datos no disponible` en preview/procesar | `app.saldoPeriodoRepo` no decorado (tests sin setup). | Verificar `PrismaService.connectPrisma()` y logs de conexión. |
| `database: disconnected` en `/health/detailed` | DNS/cred/MySQL caído. | Revisar `connectionString.mariaDb`, firewall, `mysql -u user -p -h host`. |
| `[RABBITMQ] Evento inválido. Enviando a DLQ sin reintentos` constante | Publisher emite payloads fuera del contrato Zod. | Ajustar schema del publisher; revisar logs en cola DLQ. |
| `[RABBITMQ] Mensaje enviado a DLQ después de reintentos` | Errores funcionales persistentes en la BD del consumidor. | Inspeccionar DLQ; revisar logs con `error` y stack. |
| Tareas duplicadas en base | De-duplicación insuficiente o scheduler ejecutó dos veces. | Confirmar unicidad de `correlation_id`, revisar logs `[SCHEDULER] Job crear-periodo creado (pending)`. |
| Logs en `logs/saldos-api-2026-07-30.json` crecen sin control | Nivel `debug` y/o mucho tráfico. | `logging.level=info` en producción. |

### 21.2 Errores comunes de configuración

| Variable | Symptoma si mal | Cómo verificar |
|---|---|---|
| `ConnectionStrings__MariaDb` | `PrismaClientInitializationError`. | Probar: `mysql -u $user -p -h $host -e "select 1"`. |
| `Server__Port` fuera de rango | Permiso denegado (< 1024 sin root). | Cambiar a puerto alto o ejecutar con capabilities. |
| `RABBITMQ__IdempotencyEnabled=true` pero no existe tabla `processed_events` | Error de Prisma en cada mensaje. | Aplicar schema o migración que cree `processed_events`. |
| `apiKeys.allowedKeys=[]` en producción | Cualquier key válida. | Cargar el secret con la lista real. |

### 21.3 Si la API no arranca (FATAL)

Síntomas: `Error iniciando API`, exits con stack trace.

Verificar:

1. Output del comando (`tsx src/main.ts`):

   ```bash
   npm start 2>&1 | head -200
   ```

2. En Docker:

   ```bash
   docker logs <container>
   ```

3. En Kubernetes:

   ```bash
   kubectl logs deploy/saldos-api --previous
   ```

Los errores típicos son:

- `ECONNREFUSED` a MySQL / RabbitMQ.
- `EADDRINUSE` en `port 3000` (otra instancia).
- `INVALID_EVENT_PAYLOAD` no es fatal; se loggea y se enruta a DLQ.

---

## 22. Apéndices

### 22.1 Glosario de la clave de 9 dimensiones

| # | Campo | Tipo físico (Prisma) | Tipo lógico | Descripción |
|---|---|---|---|---|
| 1 | `PeriodoId` | `BigInt Unsigned` | número | ID del periodo en `saldos_contables_periodos`. |
| 2 | `CuentaContableId` | `BigInt Unsigned?` | número | Cuenta contable (PUC). |
| 3 | `TerceroId` | `BigInt Unsigned?` | número | Tercero (cliente/proveedor/empleado). |
| 4 | `CentroCostoId` | `BigInt Unsigned?` | número | Centro de costo. |
| 5 | `LibroContableId` | `BigInt Unsigned?` | número | Libro contable. |
| 6 | `UnidadNegocioId` | `BigInt Unsigned?` | número | Unidad de negocio. |
| 7 | `CentroOperacionId` | `BigInt Unsigned?` | número | Centro de operación. |
| 8 | `CategorizacionId` | `BigInt Unsigned?` | número | Categorización. |
| 9 | `ModeloCarteraId` | `BigInt?` | número | Modelo de cartera. |

> En el procesamiento RabbitMQ y batch, las claves con valor `null/undefined` se canonicalizan al literal `"null"` en la representación string interna (`buildSaldoKey` / `keyStr`).

### 22.2 Convenciones de código relevantes

- **Módulo:** ESM puro (`"type": "module"`). Importaciones siempre con extensión `.js` aunque el archivo fuente sea `.ts` (Node-resolve transpila).
- **Decoradores Fastify:** la app decora `movimientoRepo`, `saldoRepo`, `saldoPeriodoRepo`, `useCase`, `config`, `logger`, `prismaClient`, `jobService`. Extensiones tipadas en `src/api/fastify.d.ts`.
- **Logs de usuario:** se prefiere `request.log.info` en routes; el `logger` Pino global es `prismaLogger`.

### 22.3 Variables de entorno — referencia rápida (ordenadas)

```text
ConnectionStrings__MariaDb
Server__Port
Server__Host
DATABASE_URL
RABBITMQ__Host
RABBITMQ__QueueName
RABBITMQ__Prefetch
RABBITMQ__RetryAttempts
RABBITMQ__RetryDelayMs
RABBITMQ__IdempotencyEnabled
RABBITMQ__ProcessedEvents__Enabled
RABBITMQ__ProcessedEvents__RetentionDays
RABBITMQ__ProcessedEvents__PurgeCron
RABBITMQ__ProcessedEvents__ChunkSize
RABBITMQ__ProcessedEvents__StuckHours
RABBITMQ__ProcessedEvents__OptimizeAfterDeletes
SCHEDULER__CreatePeriodoCron
SALDOS_JOB_STORE_PATH
SALDOS_BULK_UPDATE_CHUNK_SIZE
SALDOS_PROGRESS_PERCENT_STEP
SALDOS_BATCH_LOG_STEP
NODE_ENV
LOG_LEVEL            # sólo scripts/benchmarkBulkUpdate.ts
```

### 22.4 Headers HTTP aceptados

| Header | Obligatorio | Notas |
|---|---|---|
| `X-API-Key` | sí en endpoints privados | case-insensitive en el server. |
| `Content-Type: application/json` | sí en POST | Fastify rechaza parse si falta. |
| `Accept` | opcional | Fastify devuelve JSON por defecto. |

### 22.5 Snippets frecuentes

#### 22.5.1 Polling de un job hasta `terminal`

```ts
const jobId = 'a1b2c3d4-…';
const apiKey = '1234567890abcdef';
const url = `http://localhost:3000/api/v1/saldos/status/${jobId}`;

while (true) {
  const r = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!r.ok) throw new Error(`status ${r.status}`);
  const job = await r.json();
  console.log(job.status, job.periodosProcesados, job.movimientosProcesados, job.eta);
  if (['completed', 'failed', 'canceled'].includes(job.status)) break;
  await new Promise(res => setTimeout(res, 2000));
}
```

#### 22.5.2 Publicar un evento RabbitMQ (modo prueba)

```bash
# Asume RABBITMQ_URL y RABBITMQ_QUEUE exportadas, y BD accesible.
tsx scripts/publishMovimientoEvent.ts 12345 Creado saldos_movimientos
```

#### 22.5.3 Generar API key consistente

```bash
npm run setup:api-key
# imprime key, anexa a config.json; reiniciar API para que recargue.
```

### 22.6 Diferencias observadas respecto a los manuales históricos

| Tema | Manual v3 menciona | Código actual | Notas |
|---|---|---|---|
| `batchSizeDefault` recomendado | 1000 | `config.json` usa 5000; el código usa `config?.value ?? 1000`. | El valor efectivo depende de `config.json`. |
| Procesamiento batch por `id` o por `nombre` | Por nombre | Por nombre confirmado en `useCase`, `repo` y tests. | Coherente. |
| "migración SQL cruda" para `processed_events` | Menciona SQL | Ahora está integrado en `schema.prisma`. | Migraciones deben venir del proyecto que provea la BD. |
| CORS | implícito | `@fastify/cors { origin: true }`. | Acepta cualquier origen. Restringible en producción. |
| TLS en conexión AMQP | no documentado | `host = amqp://...` sin TLS explícito. | Si RabbitMQ expone AMQPS, ajustar URI. |

### 22.7 Referencias cruzadas (archivos importantes)

| Tema | Archivo |
|---|---|
| Bootstrap Fastify + decoradores | `src/api/server.ts` |
| Carga de config y env overrides | `src/api/config.ts` |
| Plugin de auth | `src/api/plugins/auth.ts` |
| Health | `src/api/routes/health.ts` |
| Saldos | `src/api/routes/saldos.ts` |
| Periodos | `src/api/routes/periodos.ts` |
| JobService (interfaz) | `src/api/services/JobService.ts` |
| JobService (memoria) | `src/api/services/InMemoryJobService.ts` |
| JobService (archivo) | `src/api/services/FileBackedJobService.ts` |
| JobService (factory) | `src/api/services/createJobService.ts` |
| Use case batch | `src/application/useCases/ProcesarSaldosContablesUseCase.ts` |
| Use case periodo | `src/application/useCases/CreatePeriodoUseCase.ts` |
| Contrato evento (Zod) | `src/application/contracts/MovimientoContableEvent.schema.ts` |
| Consumer AMQP | `src/api/rabbitmq/RabbitMQConsumer.ts` |
| Procesador AMQP | `src/api/rabbitmq/MessageProcessor.ts` |
| Scheduler periodo | `src/api/scheduler/PeriodoScheduler.ts` |
| Scheduler purga | `src/api/scheduler/PurgeProcessedEventsScheduler.ts` |
| Prisma client | `src/infrastructure/persistence/PrismaService.ts` |
| Repos saldos | `src/infrastructure/persistence/SaldoContableRepository.ts` |
| Repos periodos | `src/infrastructure/persistence/SaldoContablePeriodoRepository.ts` |
| Repos movimientos | `src/infrastructure/persistence/MovimientoContableRepository.ts` |
| Repos idempotencia | `src/infrastructure/persistence/ProcessedEventRepository.ts` |
| Schema Prisma | `prisma/schema.prisma` |
| Manifiestos k8s | `k8s/*.yaml` |
| Dockerfile | `Dockerfile` |
| Script generar API key | `scripts/generateApiKey.ts` |
| Script publicar evento | `scripts/publishMovimientoEvent.ts` |
| Script benchmark | `scripts/benchmarkBulkUpdate.ts` |
| Tests | `__tests__/**` |

---

> Fin del documento. Para dudas adicionales o secciones que considere ampliar, indique el identificador del tema (e.g., "§12 Mensajería") y se detallará.
