# Manual de Usuario v2 — Saldos Node API

API de procesamiento contable para cálculo de saldos (Fastify + Prisma/MySQL, TypeScript), con integración de eventos RabbitMQ e idempotencia. Esta versión amplía el manual con todas las funcionalidades, configuraciones, tablas de base de datos, algoritmos y operación.

---

## Tabla de contenidos

1. Introducción y arquitectura
2. Requisitos previos e instalación
3. Configuración (archivo y variables de entorno)
4. Autenticación (X-API-Key)
5. Endpoints HTTP (Health, Saldos, Periodos)
6. Modelo de Jobs (seguimiento y cancelación)
7. Base de datos: tablas, campos, índices
8. Algoritmos de negocio (procesamiento de saldos y creación de periodo)
9. Integración RabbitMQ (contrato de eventos, validación Zod, reintentos)
10. Idempotencia y tabla processed_events
11. Scheduler de purga de eventos procesados
12. Scheduler de creación automática de periodos
13. Operación, despliegue y logging
14. Ejemplos (curl y JSON)
15. Pruebas (tests) y cobertura
16. Resolución de problemas y ajuste de rendimiento
17. Buenas prácticas y seguridad

---

## 1. Introducción y arquitectura

- API HTTP basada en Fastify (puerto por defecto 3000).
- Capa de persistencia con Prisma sobre MySQL/MariaDB.
- Procesamiento batch de movimientos contables por periodos, acumulando saldos por una clave de 9 dimensiones.
- Integración opcional con RabbitMQ para procesar eventos incrementales (deltas) con idempotencia.
- Seguimiento de procesos de larga duración vía un JobService (persistencia en archivo con fallback a memoria).

Estructura principal (resumen):
- src/api: servidor Fastify, rutas, autenticación, consumidores RabbitMQ, schedulers.
- src/application: casos de uso, contratos, abstracciones.
- src/domain: entidades y tipos de dominio.
- src/infrastructure/persistence: PrismaService y repositorios.
- prisma/: schema.prisma y migraciones SQL.
- docs/: manuales.

---

## 2. Requisitos previos e instalación

Requisitos:
- Node.js 22+
- MySQL/MariaDB accesible
- npm (o pnpm)

Instalación:
- npm ci
- npx prisma generate

Ejecución:
- npm start (producción)
- npm run dev:api (desarrollo con recarga)

La API escucha por defecto en http://0.0.0.0:3000

---

## 3. Configuración (archivo y variables de entorno)

Archivo raíz config.json (ejemplo simplificado):
{
  "connectionString": { "mariaDb": "mysql://user:pass@host:3306/cuentas" },
  "apiKeys": { "allowedKeys": ["<key1>", "<key2>"] },
  "procesamientoMovimientos": { "fechaDesdeDefault": "2000-01-01", "batchSizeDefault": 1000 },
  "server": { "port": 3000, "host": "0.0.0.0" },
  "rabbitmq": {
    "host": "amqp://localhost",
    "queueName": "saldos_movimientos",
    "prefetch": 1,
    "retryAttempts": 3,
    "retryDelayMs": 5000,
    "idempotencyEnabled": false,
    "processedEvents": {
      "enabled": true,
      "retentionDays": 90,
      "purgeCron": "30 3 * * *",
      "chunkSize": 5000,
      "stuckHours": 24,
      "optimizeAfterDeletes": 100000
    }
  },
  "scheduler": { "createPeriodoCron": "30 0 1 * *" }
}

Sobrescritura por variables de entorno (principales):
- ConnectionStrings__MariaDb -> connectionString.mariaDb
- Server__Port -> server.port
- Server__Host -> server.host
- RABBITMQ__Host, RABBITMQ__QueueName, RABBITMQ__Prefetch
- RABBITMQ__RetryAttempts, RABBITMQ__RetryDelayMs
- RABBITMQ__IdempotencyEnabled ("true" para activar)
- RABBITMQ__ProcessedEvents__Enabled, __RetentionDays, __PurgeCron, __ChunkSize, __StuckHours, __OptimizeAfterDeletes
- SCHEDULER__CreatePeriodoCron
- SALDOS_JOB_STORE_PATH (ruta de persistencia de jobs)
- SALDOS_BULK_UPDATE_CHUNK_SIZE (por defecto 500 para updates masivos)
- SALDOS_PROGRESS_PERCENT_STEP (por defecto 5)
- SALDOS_BATCH_LOG_STEP (por defecto 10)

Notas:
- Prisma usa DATABASE_URL; el proyecto resuelve y setea process.env.DATABASE_URL a partir de las claves anteriores si no viene definida.
- No comitear config.json con credenciales reales.

---

## 4. Autenticación (X-API-Key)

- Rutas públicas: /health, /health/detailed, /health/metrics, /documentation
- Resto de rutas requieren header X-API-Key.
- Si apiKeys.allowedKeys está vacío, se acepta cualquier valor (útil en dev); si no, debe pertenecer a la lista.

Errores típicos:
- 401: Falta X-API-Key o no válida.

---

## 5. Endpoints HTTP

5.1 Health (públicos)
- GET /health -> { status, timestamp }
- GET /health/detailed -> { status, database, timestamp }
- GET /health/metrics -> { database, timestamp }

5.2 Saldos (requieren X-API-Key)
- POST /api/v1/saldos/preview
  - Body: { fechaDesde: "yyyy-MM-dd", batchSize?: number }
  - Valida formato; batchSize se recorta a [1000, 10000] (si omite, usa config)
  - Respuesta: { fechaDesde, batchSize, periodosCount, periodos: [{ id, nombre }], mensaje }

- POST /api/v1/saldos/procesar
  - Body: { fechaDesde: "yyyy-MM-dd", batchSize?: number }
  - Crea job asíncrono; solo 1 job en processing a la vez
  - Respuesta 202: { jobId, status, fechaDesde, batchSize }

- GET /api/v1/saldos/status/:jobId
  - Respuesta 200: detalle del job
  - 404 si no existe

- GET /api/v1/saldos/jobs
  - Query: status?, limit? (por defecto 50)
  - Respuesta: array de jobs

- GET /api/v1/saldos/jobs/metrics
  - Respuesta: { total, pending, processing, completed, failed, canceled }

- POST /api/v1/saldos/cancel/:jobId
  - Cancela si el job está en processing; 202 si cancela, 409 si no está ejecutándose, 404 si no existe

5.3 Periodos (requieren X-API-Key)
- POST /api/v1/periodos
  - Body: { fecha: "yyyy-MM-dd" }
  - Reglas previas: no duplicado, debe existir periodo previo y ser inmediato anterior
  - Crea job asíncrono crear-periodo:YYYYMM:uuid
  - Respuestas: 202 (job), 409 (duplicado o ya hay job creando periodo), 400 (reglas negocio), 503 (repos no disponibles)

- GET /api/v1/periodos/status/:jobId
  - Respuesta 200 o 404

Swagger UI disponible en /documentation

---

## 6. Modelo de Jobs (seguimiento y cancelación)

Estados: pending, processing, completed, failed, canceled

Estructura principal:
- jobId (string)
- status
- fechaDesde (para procesamiento de saldos)
- batchSize
- periodosProcesados, movimientosProcesados, movimientosCuentaProcesados
- tiempoTotalMs, eta, error, createdAt, updatedAt, resultado

Almacenamiento:
- FileBackedJobService (persistente en JSON, ruta SALDOS_JOB_STORE_PATH, por defecto logs/jobs-store.json, máx 1000 jobs)
- InMemoryJobService (fallback, máx 100 jobs)
- Limpieza automática de jobs >24h

Cancelación:
- POST /api/v1/saldos/cancel/:jobId cambia a status canceled si estaba processing.

---

## 7. Base de datos: tablas, campos, índices

Nota: El esquema no define claves foráneas explícitas; las relaciones son lógicas a nivel aplicación.

7.1 movimiento_contable
- id BIGINT UNSIGNED PK autoincrement
- consecutivo INT (default 0)
- estado VARCHAR(255)
- fecha DATETIME(0)
- comprobante_id BIGINT NULL
- observacion VARCHAR(255) NULL
- created_at, updated_at TIMESTAMP NULL
- librocontable_id BIGINT NULL
- modelo_id BIGINT NULL, modelo VARCHAR(255) NULL
- documento VARCHAR(255) NULL
- usuariocreacion_id, usuariomodificacion_id BIGINT NULL
- periodo_id BIGINT NULL
- cerrado BOOLEAN default false
- hashconsecutivo BIGINT NULL
- consecutivoestado (enum: PENDIENTE | ASIGNADO) NULL
Índices: (fecha, periodo_id), (periodo_id, id)

7.2 movimiento_contable_cuentas
- id BIGINT PK autoincrement
- movimientocontable_id BIGINT (FK lógica)
- cuentacontable_id BIGINT
- tercero_id, centrocosto_id BIGINT NULL
- base DECIMAL(18,2) default 0.00
- debito DECIMAL(18,2) default 0.00
- credito DECIMAL(18,2) default 0.00
- observacion VARCHAR(255) NULL
- created_at, updated_at TIMESTAMP NULL
- librocontable_id, unidadnegocio_id BIGINT NULL
- trm DECIMAL(18,6) default 0
- factorconversion DECIMAL(18,6) default 0
- centrooperacion_id, categorizacion_id BIGINT NULL
- modelocartera_id BIGINT NULL, modelocartera VARCHAR(255) NULL
- conceptotributario_id BIGINT NULL
Índice: (movimientocontable_id)

7.3 saldos_contables
- id BIGINT PK autoincrement
- periodo_id BIGINT NOT NULL
- class VARCHAR(255) NULL
- entidad_id BIGINT NULL
- tercero_id, cuentacontable_id, centrocosto_id BIGINT NULL
- saldoinicialdebito, saldoinicialcredito DECIMAL(18,2) default 0
- debito, credito DECIMAL(18,2) default 0
- saldofinaldebito, saldofinalcredito DECIMAL(18,2) default 0
- created_at, updated_at TIMESTAMP NULL
- librocontable_id, unidadnegocio_id, centrooperacion_id, categorizacion_id BIGINT NULL
- cierre BOOLEAN default false
- modelocartera_id BIGINT NULL, modelocartera VARCHAR(255) NULL
- conceptotributario_id BIGINT NULL
Índices:
- (periodo_id, tercero_id, cuentacontable_id, centrocosto_id)
- saldos_contables_dim9_IDX: (periodo_id, cuentacontable_id, tercero_id, centrocosto_id, librocontable_id, unidadnegocio_id, centrooperacion_id, categorizacion_id, modelocartera_id)

7.4 saldos_contables_periodos
- id BIGINT PK autoincrement
- nombre VARCHAR(255) (único lógico, ordenación)
- periodoinicio DATE NULL, periodofin DATE NULL
- cierre BOOLEAN default true
- created_at, updated_at TIMESTAMP NULL
- usuariocreacion_id, usuariomodificacion_id BIGINT NULL
- recalculologico BOOLEAN (requerido en DB)
- cierreanio BOOLEAN default false, cierrecontable BOOLEAN default false
Índices: (nombre), (usuariocreacion_id), (usuariomodificacion_id)

7.5 processed_events (migración SQL cruda)
- id BIGINT PK autoincrement
- correlation_id VARCHAR(100) UNIQUE NOT NULL
- movimiento_id BIGINT NULL
- periodo_id BIGINT NOT NULL
- estado VARCHAR(20) NOT NULL (processing | completed)
- error TEXT NULL
- payload_hash CHAR(64) NULL
- created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
- updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
Índices: UNIQUE(correlation_id), (periodo_id)

---

## 8. Algoritmos de negocio

8.1 Procesamiento de saldos (ProcesarSaldosContablesUseCase)
- Entrada: fechaDesde (string yyyy-MM-dd), batchSize (1000–10000), jobId, opciones (onProgress, shouldCancel, progressIntervalMs)
- Descubrimiento de periodos: saldos_contables_periodos con periodoinicio >= fechaDesde, ordenados por nombre ASC. Si no hay, error.
- Para cada periodo en orden:
  1) Cero-inicializar saldos del periodo (6 campos monetarios a 0).
  2) Procesar movimientos por lotes (getBatchByPeriodo(periodoId, batchSize)) y agrupar cuentas por 9 dimensiones, sumando debito/credito.
  3) Para cada saldo de la clave 9D: tomar saldoInicial del periodo anterior (final del anterior) o 0 si no hay; calcular saldoFinal como saldoInicial + debitos/creditos del periodo.
  4) Persistir en bloque: inserciones de nuevos y UPDATE masivo por CASE sobre id para existentes.
- Progreso: contadores de periodos/movimientos, ETA; cancelación cooperativa.

Fórmulas por saldo:
- SaldoInicialDebito  = (prior?.saldoFinalDebito  || 0)
- SaldoInicialCredito = (prior?.saldoFinalCredito || 0)
- SaldoFinalDebito  = SaldoInicialDebito  + Debito
- SaldoFinalCredito = SaldoInicialCredito + Credito

8.2 Creación de periodo (CreatePeriodoUseCase)
- Entrada: fecha (Date)
- Calcula nombre YYYYMM, periodoInicio (1er día 00:00:00.000 UTC) y periodoFin (último día 23:59:59.999 UTC)
- Reglas:
  - No duplicado (existsByNombre)
  - Debe existir un periodo anterior
  - Debe ser inmediatamente anterior (sin gaps)
- Crea registro en saldos_contables_periodos (cierre=false, cierreAnio=false, recalculoLogico=false)
- Copia saldos del periodo anterior a nuevo:
  - saldoinicialdebito = saldofinaldebito(anterior)
  - saldoinicialcredito = saldofinalcredito(anterior)
  - debito = 0, credito = 0
  - saldofinaldebito = saldofinaldebito(anterior)
  - saldofinalcredito = saldofinalcredito(anterior)
  - cierre = false

---

## 9. Integración RabbitMQ

9.1 Consumidor (RabbitMQConsumer)
- Conexión a host; assertQueue(queueName, durable:true) con x-message-ttl=60000 y DLQ routing a <queue>.dlq
- Prefetch configurable (por defecto 1)
- Consumo con noAck:false (ACK manual)
- Reintentos con backoff exponencial: retryDelayMs * 2^reintento, hasta retryAttempts; al exceder, NACK sin requeue a DLQ
- Errores de validación del payload (INVALID_EVENT_PAYLOAD) -> NACK inmediato a DLQ (sin reintentos)

9.2 Contrato de evento (MovimientoContableEvent)
- Campos:
  - id (number)
  - fecha (string ISO o Date)
  - estado (string)
  - Estado ("Creado" | "Borrado")
  - CorrelationId (string)
  - PeriodoId (number)
  - cuentas: array de objetos con:
    - MovimientoContableId (number), CuentaContableId (number)
    - TerceroId?, CentroCostoId?, LibroContableId?, UnidadNegocioId?, CentroOperacionId?, CategorizacionId?, ModeloCarteraId?
    - ModeloCartera? (string)
    - ConceptoTributarioId? (number)
    - Debito (number), Credito (number)
- Validación estricta con Zod; se normaliza fecha y se rechazan claves desconocidas.

9.3 Procesamiento de eventos (MessageProcessor)
- Construye deltas por clave 9D (PeriodoId + 8 dimensiones). Si Estado = "Borrado" aplica signo -1.
- Itera periodos desde PeriodoId del evento en orden ascendente:
  - En p0 (periodo del evento): aplica delta (Debito/Credito) sobre valores actuales; recalcula SaldoFinal.
  - En p1..pn: NO modifica Debito/Credito; solo establece SaldoInicial a SaldoFinal del periodo previo y recalcula SaldoFinal (propagación).
- Persiste por clave 9D con updateByKey (upsert lógico).

---

## 10. Idempotencia y tabla processed_events

- Activable con rabbitmq.idempotencyEnabled=true.
- Proceso dentro de transacción Prisma:
  1) Insert en processed_events con estado "processing" y correlation_id único.
  2) Si hay violación única (duplicado), se asume procesado previamente y se finaliza sin reprocesar.
  3) Tras éxito del procesamiento, se marca estado "completed".
- Campos útiles: correlation_id, periodo_id, movimiento_id?, payload_hash?, timestamps.

---

## 11. Scheduler de purga de eventos procesados

- Habilitado si idempotencyEnabled y processedEvents.enabled.
- Cron por defecto: "30 3 * * *" (diario 03:30).
- Usa GET_LOCK('processed_events_purge', 0) para asegurar instancia única.
- Borra en chunks (LIMIT chunkSize):
  - completed con created_at < ahora - retentionDays
  - processing "atascados" con created_at < ahora - stuckHours
- Si total eliminados >= optimizeAfterDeletes ejecuta OPTIMIZE TABLE processed_events.

---

## 12. Scheduler de creación automática de periodos

- Cron configurable (scheduler.createPeriodoCron), por defecto "30 0 1 * *" (día 1, 00:30).
- Crea job crear-periodo:YYYYMM si no hay otro en pending/processing.
- Aplica las mismas reglas de negocio que el endpoint manual.

---

## 13. Operación, despliegue y logging

Ejecución local:
- npm ci
- npx prisma generate
- npm start

Docker/Kubernetes:
- Dockerfile multi-stage (Node 22 Alpine), ejecuta prisma generate en build.
- Manifiestos en k8s/ (Deployment, Service, Ingress, ConfigMap, Secret). Corre como usuario no root.

Logging:
- Pino; posibilidad de rolling file (config.logging).
- Conexión a DB tolerante: si falla al iniciar, la API sigue levantando (rutas que dependan de DB pueden responder 503).

Swagger:
- /documentation (OpenAPI generado con @fastify/swagger)

---

## 14. Ejemplos

14.1 Preview
curl -X POST http://localhost:3000/api/v1/saldos/preview \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <key>" \
  -d '{ "fechaDesde": "2024-01-01", "batchSize": 5000 }'

14.2 Procesar
curl -X POST http://localhost:3000/api/v1/saldos/procesar \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <key>" \
  -d '{ "fechaDesde": "2024-01-01", "batchSize": 5000 }'

14.3 Estado de job
curl http://localhost:3000/api/v1/saldos/status/<jobId> -H "X-API-Key: <key>"

14.4 Crear periodo
curl -X POST http://localhost:3000/api/v1/periodos \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <key>" \
  -d '{ "fecha": "2026-08-01" }'

14.5 Evento RabbitMQ (JSON ejemplo)
{
  "id": 12345,
  "fecha": "2026-07-20T00:00:00.000Z",
  "estado": "APROBADO",
  "Estado": "Creado",
  "CorrelationId": "e9c6d8b2-...",
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
      "Debito": 1000.00,
      "Credito": 0.00
    }
  ]
}

---

## 15. Pruebas y cobertura

- Framework: vitest (globals: true).
- Ejecutar: npm test o npm run test:coverage
- Pruebas incluyen: entidades de dominio, ProcesarSaldosContablesUseCase (repos mockeados), JobService.

---

## 16. Resolución de problemas y tuning

Problemas comunes:
- 503 Repos no disponibles: el servidor inició sin conexión DB; ver logs y cadena de conexión.
- 409 en /saldos/procesar: ya hay un job processing; espere o cancele.
- Eventos duplicados en RabbitMQ: active idempotencia y verifique correlationId.
- DLQ creciente: valide el contrato Zod; errores de payload no se reintentan.

Rendimiento:
- Ajuste batchSize (1000–10000).
- SALDOS_BULK_UPDATE_CHUNK_SIZE (por defecto 500) para updates masivos.
- Prefetch de RabbitMQ (por defecto 1) si procesa eventos.

---

## 17. Buenas prácticas y seguridad

- No exponer config.json con credenciales; use variables de entorno en producción.
- Restrinja X-API-Key con apiKeys.allowedKeys.
- Mantenga purga de processed_events activa si usa idempotencia.
- Despliegue como usuario no root (Dockerfile ya lo hace).

Glosario (claves de 9 dimensiones):
- PeriodoId, CuentaContableId, TerceroId, CentroCostoId, LibroContableId, UnidadNegocioId, CentroOperacionId, CategorizacionId, ModeloCarteraId.
