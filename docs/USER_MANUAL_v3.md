# Manual de Usuario v3 — Saldos Node API (Fusionado)

Base: versión 2 (más actual). Se integran contenidos útiles de la versión 1 que no estaban en v2, principalmente ejemplos detallados de requests/responses, referencias rápidas y formatos de error.

---

## Tabla de contenidos

1. Introducción y arquitectura
2. Requisitos e instalación
3. Configuración (archivo y variables de entorno)
4. Autenticación (X-API-Key) + ejemplos de errores
5. Endpoints HTTP (Health, Saldos, Periodos) con ejemplos
6. Modelo de Jobs (estructura y almacenamiento) + tipo de datos de ejemplo
7. Base de datos: tablas, campos, índices (incluye processed_events)
8. Algoritmos (procesamiento de saldos y creación de periodo)
9. RabbitMQ (contrato, validación, reintentos)
10. Idempotencia (processed_events)
11. Schedulers (purga e ingesta de periodos)
12. Operación, despliegue y logging
13. Ejemplos (curl y JSON)
14. Referencias rápidas (endpoints y límites)
15. Pruebas y cobertura
16. Troubleshooting y tuning
17. Buenas prácticas y seguridad

---

## 1. Introducción y arquitectura

- Fastify API (puerto 3000 por defecto), Prisma/MySQL, TypeScript.
- Procesamiento batch por periodos, clave de 9 dimensiones.
- Integración RabbitMQ opcional (eventos incrementales) con idempotencia.
- Seguimiento via JobService (archivo con fallback a memoria).

Estructura (resumen): src/api, src/application, src/domain, src/infrastructure/persistence, prisma/, docs/.

---

## 2. Requisitos e instalación

- Node 22+, MySQL/MariaDB, npm o pnpm.
- Instalación: `npm ci` y `npx prisma generate`.
- Ejecución: `npm start` (prod), `npm run dev:api` (dev).
- URL: http://0.0.0.0:3000

---

## 3. Configuración (archivo y variables de entorno)

Ejemplo config.json (resumen):
{
  "connectionString": { "mariaDb": "mysql://user:pass@host:3306/cuentas" },
  "apiKeys": { "allowedKeys": ["<key>"] },
  "procesamientoMovimientos": { "fechaDesdeDefault": "2000-01-01", "batchSizeDefault": 1000 },
  "server": { "port": 3000, "host": "0.0.0.0" },
  "rabbitmq": { "host": "amqp://localhost", "queueName": "saldos_movimientos", "prefetch": 1, "retryAttempts": 3, "retryDelayMs": 5000, "idempotencyEnabled": false, "processedEvents": { "enabled": true, "retentionDays": 90, "purgeCron": "30 3 * * *", "chunkSize": 5000, "stuckHours": 24, "optimizeAfterDeletes": 100000 } },
  "scheduler": { "createPeriodoCron": "30 0 1 * *" }
}

Principales overrides por entorno: ConnectionStrings__MariaDb, Server__Port, Server__Host, RABBITMQ__*, SCHEDULER__CreatePeriodoCron, SALDOS_JOB_STORE_PATH, SALDOS_BULK_UPDATE_CHUNK_SIZE, SALDOS_PROGRESS_PERCENT_STEP, SALDOS_BATCH_LOG_STEP.

Notas: DATABASE_URL se resuelve desde estas claves si no viene definida. No comitear credenciales.

---

## 4. Autenticación (X-API-Key)

- Rutas públicas: /health, /health/detailed, /health/metrics, /documentation.
- Demás rutas requieren `X-API-Key`.
- Si `allowedKeys` está vacío, se acepta cualquier valor (dev). En prod, configure la lista.

Ejemplos de error (añadidos de v1):
- 401 sin header: { "error": "API key requerida", "message": "El header X-API-Key es obligatorio" }
- 401 inválida: { "error": "API key inválida" }

---

## 5. Endpoints HTTP

### 5.1 Health (públicos)
- GET /health → { status, timestamp }
  - Ejemplo 200: { "status": "ok", "timestamp": "2026-07-13T10:30:00.000Z" }
- GET /health/detailed → { status, database, timestamp }
  - database: connected | disconnected | not configured
- GET /health/metrics → { database, timestamp }

### 5.2 Saldos (requiere X-API-Key)

- POST /api/v1/saldos/preview
  - Body: { fechaDesde: "yyyy-MM-dd", batchSize?: number }
  - Respuesta 200 (ejemplo): { "fechaDesde": "2024-01-01", "batchSize": 5000, "periodosCount": 5, "periodos": [ { "id": 10, "nombre": "202401" } ], "mensaje": "Se procesarían 5 períodos con batch size 5000" }
  - Errores (ejemplos): 400 validación { "error": "Validación fallida", "details": [...] }; 400 sin periodos { "error": "No se encontraron periodos con periodoInicio >= 2024-01-01" }; 503 { "error": "Base de datos no disponible" }

- POST /api/v1/saldos/procesar
  - Body: { fechaDesde: "yyyy-MM-dd", batchSize?: number }
  - 202 (ejemplo): { "jobId": "uuid", "status": "pending", "fechaDesde": "2024-01-01", "batchSize": 5000 }
  - Errores: 409 si ya hay job en ejecución { "error": "Ya existe un job en ejecución", "runningJobId": "uuid" }

- GET /api/v1/saldos/status/:jobId
  - 200 (ejemplo): { "jobId": "uuid", "status": "processing", "periodosProcesados": 3, "movimientosProcesados": 15000, "movimientosCuentaProcesados": 4500, "tiempoTotalMs": 12500, "eta": "aprox. 30 segundos", "createdAt": "...", "updatedAt": "..." }
  - 404: { "error": "Job no encontrado", "jobId": "uuid" }

- GET /api/v1/saldos/jobs
  - Query: status?, limit? (default 50)
  - 200 (ejemplo): [ { "jobId": "uuid", "status": "completed", "fechaDesde": "2024-01-01", "batchSize": 5000, "periodosProcesados": 5, "resultado": { ... } } ]

- GET /api/v1/saldos/jobs/metrics
  - 200 (ejemplo): { "total": 15, "pending": 0, "processing": 1, "completed": 12, "failed": 2, "canceled": 0 }

- POST /api/v1/saldos/cancel/:jobId
  - 202 (ejemplo): { "jobId": "uuid", "status": "canceled" }
  - 404: { "error": "Job no encontrado", "jobId": "uuid" }
  - 409: { "jobId": "uuid", "status": "completed", "error": "No se pudo cancelar: el job no está en ejecución (estado actual: completed)." }

### 5.3 Periodos (requiere X-API-Key)

- POST /api/v1/periodos
  - Body: { fecha: "yyyy-MM-dd" }
  - 202 (ejemplo): { "jobId": "crear-periodo:202608:uuid", "status": "pending", "fecha": "2026-08-01T00:00:00.000Z" }
  - 409 si ya existe job crear-periodo en curso; 400 por negocio (duplicado, sin anterior, no inmediato)

- GET /api/v1/periodos/status/:jobId → 200/404

Swagger: /documentation

---

## 6. Modelo de Jobs

Estados: pending | processing | completed | failed | canceled

Estructura (añadido el tipo de v1 como referencia):
```ts
type Job = {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'canceled';
  fechaDesde: string;
  batchSize: number;
  periodosProcesados: number;
  movimientosProcesados: number;
  movimientosCuentaProcesados: number;
  tiempoTotalMs: number;
  eta?: string;
  error?: string;
  createdAt: Date;
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

Almacenamiento: FileBackedJobService (JSON, SALDOS_JOB_STORE_PATH, máx 1000) con fallback InMemory (máx 100). Limpieza >24h.

---

## 7. Base de datos (resumen)

- movimiento_contable: movimientos; índices (fecha,periodo_id) y (periodo_id,id).
- movimiento_contable_cuentas: líneas de cuenta; índice (movimientocontable_id).
- saldos_contables: saldos por 9D; índice compuesto 9D saldos_contables_dim9_IDX.
- saldos_contables_periodos: periodos (nombre YYYYMM), límites de fecha; índices por nombre y usuarios.
- processed_events: idempotencia (UNIQUE correlation_id; índice por periodo_id).

---

## 8. Algoritmos

Procesamiento (batch por periodo):
- Cero-inicializar saldos del periodo.
- Agrupar movimientos por 9D; sumar Debito/Credito.
- SaldoInicial = SaldoFinal del periodo anterior (o 0).
- SaldoFinal = SaldoInicial + Debito/Credito.
- Persistencia masiva con CASE y createMany.

Creación de periodo:
- Reglas: no duplicado, debe existir anterior, debe ser inmediato.
- Copia saldos del periodo previo: inicial = final previo; debito/credito = 0.

---

## 9. RabbitMQ

- Contrato validado por Zod (PeriodoId top-level, CorrelationId obligatorio, cuentas con 9D + montos).
- Consumidor con TTL, DLQ, prefetch y backoff exponencial.
- Procesador aplica delta solo en p0; propaga saldos a p1..pn sin tocar Debito/Credito.

---

## 10. Idempotencia (processed_events)

- createProcessing -> run -> markCompleted en transacción.
- Duplicados (violación UNIQUE correlation_id) se reconocen y se omiten.

---

## 11. Schedulers

- Purga processed_events: cron, GET_LOCK, borrado por chunks, OPTIMIZE opcional.
- Creación automática de periodos: cron, misma lógica que endpoint.

---

## 12. Operación, despliegue y logging

- Dockerfile multi-stage; k8s manifests; usuario no root.
- Logs con pino; resiliencia a inicio sin DB (rutas pueden responder 503).

---

## 13. Ejemplos (curl y JSON)

Preview:
curl -X POST http://localhost:3000/api/v1/saldos/preview \
  -H "Content-Type: application/json" -H "X-API-Key: <key>" \
  -d '{ "fechaDesde": "2024-01-01", "batchSize": 5000 }'

Procesar:
curl -X POST http://localhost:3000/api/v1/saldos/procesar \
  -H "Content-Type: application/json" -H "X-API-Key: <key>" \
  -d '{ "fechaDesde": "2024-01-01", "batchSize": 5000 }'

Estado job:
curl http://localhost:3000/api/v1/saldos/status/<jobId> -H "X-API-Key: <key>"

Crear periodo:
curl -X POST http://localhost:3000/api/v1/periodos \
  -H "Content-Type: application/json" -H "X-API-Key: <key>" \
  -d '{ "fecha": "2026-08-01" }'

Evento RabbitMQ (ejemplo JSON): ver sección 9.

---

## 14. Referencias rápidas

Endpoints:
- GET /health, /health/detailed, /health/metrics (públicos)
- POST /api/v1/saldos/preview, POST /api/v1/saldos/procesar, GET /api/v1/saldos/status/:jobId, GET /api/v1/saldos/jobs, GET /api/v1/saldos/jobs/metrics, POST /api/v1/saldos/cancel/:jobId
- POST /api/v1/periodos, GET /api/v1/periodos/status/:jobId

Límites/valores por defecto (añadidos de v1 donde aplican):
- batchSize: 1000–10000 (default configurable, p.ej. 1000/5000)
- listJobs limit: 50 por defecto
- Jobs máx (archivo): 1000; (memoria): 100
- Limpieza automática de jobs: >24h

---

## 15. Pruebas y cobertura

- vitest; `npm test`, `npm run test:coverage`.

---

## 16. Troubleshooting y tuning

- 503 repos no disponibles: revisar conexión MySQL/variables.
- 409 al procesar: ya hay job en ejecución; cancelar o esperar.
- DLQ RabbitMQ: revisar contrato Zod; INVALID_EVENT_PAYLOAD no reintenta.
- Rendimiento: batchSize, SALDOS_BULK_UPDATE_CHUNK_SIZE, prefetch.

---

## 17. Buenas prácticas y seguridad

- Usar env vars en prod; proteger X-API-Key.
- Activar purga de processed_events con idempotencia.
- Ejecutar como no root (Dockerfile ya aplica).
