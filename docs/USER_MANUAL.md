# Manual de Usuario — Saldos Node API

API de procesamiento contable para el cálculo de saldos en sistemas de cuentas. Construida con Fastify, Prisma/MySQL y TypeScript.

---

## Tabla de Contenidos

1. [Requisitos Previos](#1-requisitos-previos)
2. [Instalación y Configuración](#2-instalación-y-configuración)
3. [Configuración](#3-configuración)
4. [Autenticación](#4-autenticación)
5. [Endpoints de Salud (Health)](#5-endpoints-de-salud-health)
6. [Endpoints de Saldos](#6-endpoints-de-saldos)
7. [Modelo de Datos de Jobs](#7-modelo-de-datos-de-jobs)
8. [Flujo de Procesamiento](#8-flujo-de-procesamiento)
9. [Variables de Entorno](#9-variables-de-entorno)
10. [Ejemplos de Consumo](#10-ejemplos-de-consumo)
11. [Swagger UI](#11-swagger-ui)
12. [Tabla `saldos_contables_periodos`](#12-tabla-saldos_contables_periodos)
13. [Referencias Rápidas](#13-referencias-rapidas)

---

## 1. Requisitos Previos

- **Node.js** 22+
- **MySQL/MariaDB** accesible desde el servidor
- **npm** (o pnpm)

### Instalación

```bash
npm ci
npx prisma generate
```

### Ejecutar el servidor

```bash
npm start              # Producción
npm run dev:api        # Desarrollo (hot-reload)
```

El servidor escucha por defecto en `http://0.0.0.0:3000`.

---

## 2. Instalación y Configuración

### 2.1 Archivo de configuración

El archivo `config.json` en la raíz del proyecto contiene toda la configuración. Ejemplo:

```json
{
  "connectionString": { "mariaDb": "mysql://pad:P2ssw0rd!d@docker:3306/cuentas" },
  "apiKeys": { "allowedKeys": ["1234567890abcdef", "abcdef1234567890"] },
  "procesamientoMovimientos": { "fechaDesdeDefault": "2000-01-01", "batchSizeDefault": 5000 },
  "logging": { "level": "info", "filePath": "logs/saldos-api-.json", "rollingInterval": "day" },
  "server": { "port": 3000, "host": "0.0.0.0" }
}
```

### 2.2 Configuración por variables de entorno

Las siguientes variables de entorno **sobrescriben** `config.json`:

| Variable de Entorno | Sobrescribe | Valor por defecto |
|---------------------|-------------|-------------------|
| `ConnectionStrings__MariaDb` | `connectionString.mariaDb` | `"mysql://root:pass@127.0.0.1:3306/cuentas"` |
| `Server__Port` | `server.port` | `3000` |
| `Server__Host` | `server.host` | `"0.0.0.0"` |

### 2.3 Estructura del config

| Sección | Propiedad | Descripción |
|---------|-----------|-------------|
| `connectionString.mariaDb` | string | URI de conexión a MySQL/MariaDB |
| `apiKeys.allowedKeys` | string[] | Lista de API keys válidas. Array vacío = cualquier key aceptada |
| `procesamientoMovimientos.fechaDesdeDefault` | string | Fecha mínima por defecto para procesamiento (`yyyy-MM-dd`) |
| `procesamientoMovimientos.batchSizeDefault` | number | Tamaño de lote por defecto (valores válidos: 1000–10000) |
| `logging.level` | string | Nivel de log: `debug`, `info`, `warn`, `error` |
| `logging.filePath` | string | Ruta base para archivos de log |
| `logging.rollingInterval` | string | Rotación de logs: `day`, `month`, etc. |
| `server.port` | number | Puerto de escucha |
| `server.host` | string | Dirección de escucha |

---

## 3. Autenticación

Todos los endpoints bajo `/api/v1/saldos/*` requieren autenticación mediante el header HTTP:

```
X-API-Key: <tu-api-key>
```

### 3.1 Funcionamiento

- Si `config.json.apiKeys.allowedKeys` es **array vacío** (`[]`), **cualquier valor** de `X-API-Key` es aceptado.
- Si contiene claves, el valor del header debe estar en esa lista.

### 3.2 Respuestas de error

| Código | Condición | Respuesta |
|--------|-----------|-----------|
| `401` | Header `X-API-Key` ausente | `{ "error": "API key requerida", "message": "El header X-API-Key es obligatorio" }` |
| `401` | API key no válida | `{ "error": "API key inválida" }` |

### 3.3 Endpoints públicos (sin autenticación)

- `GET /health`
- `GET /health/detailed`
- `GET /health/metrics`
- `GET /documentation` (Swagger UI)

---

## 4. Endpoints de Salud (Health)

Estos endpoints **no requieren autenticación** y permiten verificar el estado del servicio y la base de datos.

### 4.1 `GET /health`

Verificación básica de estado del servicio.

**Solicitud:**

```http
GET /health HTTP/1.1
Host: localhost:3000
```

**Respuesta `200 OK`:**

```json
{
  "status": "ok",
  "timestamp": "2026-07-13T10:30:00.000Z"
}
```

---

### 4.2 `GET /health/detailed`

Verificación del estado con información de conectividad a la base de datos.

**Solicitud:**

```http
GET /health/detailed HTTP/1.1
Host: localhost:3000
```

**Respuesta `200 OK`:**

```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-07-13T10:30:00.000Z"
}
```

**Valores posibles para `database`:**

| Valor | Significado |
|-------|-------------|
| `"connected"` | Conexión exitosa a MySQL/MariaDB |
| `"disconnected"` | Error al conectar a la base de datos |
| `"not configured"` | No hay cadena de conexión configurada |

---

### 4.3 `GET /health/metrics`

Métricas operativas con estado de la base de datos (similar a `/health/detailed`, sin campo `status`).

**Solicitud:**

```http
GET /health/metrics HTTP/1.1
Host: localhost:3000
```

**Respuesta `200 OK`:**

```json
{
  "timestamp": "2026-07-13T10:30:00.000Z",
  "database": "connected"
}
```

---

## 5. Endpoints de Saldos

Todos los endpoints de esta sección **requieren** el header `X-API-Key`.

### 5.1 `POST /api/v1/saldos/preview`

**Preview (dry-run) del procesamiento de saldos.** No ejecuta procesamiento real; solo devuelve información sobre qué períodos se procesarían.

**Solicitud:**

```http
POST /api/v1/saldos/preview HTTP/1.1
Host: localhost:3000
Content-Type: application/json
X-API-Key: 1234567890abcdef

{
  "fechaDesde": "2024-01-01",
  "batchSize": 5000
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `fechaDesde` | string | Sí | Fecha inicial en formato `yyyy-MM-dd`. Debe coincidir con `/^\d{4}-\d{2}-\d{2}$/` |
| `batchSize` | number | No | Tamaño de lote. Se recorta automáticamente al rango `[1000, 10000]`. Si no se provee, se usa `config.procesamientoMovimientos.batchSizeDefault` |

**Respuesta `200 OK`:**

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

| Campo | Descripción |
|-------|-------------|
| `periodosCount` | Cantidad de períodos que se procesarían |
| `periodos` | Array de objetos `{ id, nombre }` ordenados por `nombre` (el mismo orden en que se procesarán) |
| `mensaje` | Mensaje descriptivo del preview |

**Códigos de error:**

| Código | Condición | Respuesta |
|--------|-----------|-----------|
| `400` | Validación fallida | `{ "error": "Validación fallida", "details": [...] }` |
| `400` | No hay periodos que cumplan la condición | `{ "error": "No se encontraron periodos con periodoInicio >= {fecha}" }` |
| `401` | API key ausente o inválida | Ver sección 3.2 |
| `500` | Error interno | `{ "error": "Error interno", "detail": "<mensaje>" }` |
| `503` | Base de datos no disponible | `{ "error": "Base de datos no disponible" }` |

---

### 5.2 `POST /api/v1/saldos/procesar`

**Inicia un procesamiento asíncrono de saldos contables.** Retorna inmediatamente con un `jobId` que puede usarse para monitorear el progreso.

**Solicitud:**

```http
POST /api/v1/saldos/procesar HTTP/1.1
Host: localhost:3000
Content-Type: application/json
X-API-Key: 1234567890abcdef

{
  "fechaDesde": "2024-01-01",
  "batchSize": 5000
}
```

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `fechaDesde` | string | Sí | Fecha inicial en formato `yyyy-MM-dd` |
| `batchSize` | number | No | Tamaño de lote. Se recorta automáticamente al rango `[1000, 10000]` |

**Respuesta `202 Accepted`:**

```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "pending",
  "fechaDesde": "2024-01-01",
  "batchSize": 5000
}
```

| Campo | Descripción |
|-------|-------------|
| `jobId` | UUID v4 del job creado |
| `status` | Estado inicial: `"pending"` o `"processing"` |
| `fechaDesde` | Fecha enviada en la solicitud |
| `batchSize` | Tamaño de lote efectivo (después del recorte) |

**Códigos de error:**

| Código | Condición | Respuesta |
|--------|-----------|-----------|
| `400` | Validación fallida | `{ "error": "Validación fallida", "details": [...] }` |
| `401` | API key ausente o inválida | Ver sección 3.2 |
| `409` | Ya existe un job en ejecución | `{ "error": "Ya existe un job en ejecución", "runningJobId": "<uuid>" }` |
| `500` | Error interno | `{ "error": "Error interno", "detail": "<mensaje>" }` |
| `503` | Use case no disponible | `{ "error": "Use case no disponible" }` |

> **Nota:** Solo puede existir **un job en ejecución** (`status: "processing"`) a la vez. Si se intenta iniciar uno nuevo mientras otro está activo, se retorna `409 Conflict`.

---

### 5.3 `GET /api/v1/saldos/status/:jobId`

**Obtiene el estado detallado de un job específico.**

**Solicitud:**

```http
GET /api/v1/saldos/status/a1b2c3d4-e5f6-7890-abcd-ef1234567890 HTTP/1.1
Host: localhost:3000
X-API-Key: 1234567890abcdef
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `jobId` (path) | string | Sí | UUID del job |

**Respuesta `200 OK`:**

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
  "eta": "aprox. 30 segundos",
  "createdAt": "2026-07-13T10:30:00.000Z",
  "updatedAt": "2026-07-13T10:30:12.500Z"
}
```

**Respuesta `404 Not Found`:**

```json
{
  "error": "Job no encontrado",
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

---

### 5.4 `GET /api/v1/saldos/jobs`

**Lista todos los jobs con filtros opcionales.**

**Solicitud:**

```http
GET /api/v1/saldos/jobs?status=completed&limit=10 HTTP/1.1
Host: localhost:3000
X-API-Key: 1234567890abcdef
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `status` (query) | string | No | Filtrar por estado: `"pending"` \| `"processing"` \| `"completed"` \| `"failed"` \| `"canceled"` |
| `limit` (query) | string | No | Máximo de resultados. Default: `50` |

**Respuesta `200 OK`:**

```json
[
  {
    "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "status": "completed",
    "fechaDesde": "2024-01-01",
    "batchSize": 5000,
    "periodosProcesados": 5,
    "movimientosProcesados": 25000,
    "movimientosCuentaProcesados": 7500,
    "tiempoTotalMs": 45000,
    "resultado": {
      "periodosProcesados": 5,
      "movimientosProcesados": 25000,
      "movimientosCuentaProcesados": 7500,
      "tiempoTotalMs": 45000
    },
    "createdAt": "2026-07-13T10:30:00.000Z",
    "updatedAt": "2026-07-13T10:31:00.000Z"
  }
]
```

---

### 5.5 `GET /api/v1/saldos/jobs/metrics`

**Obtiene contadores de jobs por estado.**

**Solicitud:**

```http
GET /api/v1/saldos/jobs/metrics HTTP/1.1
Host: localhost:3000
X-API-Key: 1234567890abcdef
```

**Respuesta `200 OK`:**

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

| Campo | Descripción |
|-------|-------------|
| `total` | Total de jobs registrados |
| `pending` | Jobs en cola pendientes |
| `processing` | Jobs en ejecución actual |
| `completed` | Jobs completados exitosamente |
| `failed` | Jobs con error |
| `canceled` | Jobs cancelados por el usuario |

---

### 5.6 `POST /api/v1/saldos/cancel/:jobId`

**Cancela un job que está en ejecución.**

**Solicitud:**

```http
POST /api/v1/saldos/cancel/a1b2c3d4-e5f6-7890-abcd-ef1234567890 HTTP/1.1
Host: localhost:3000
X-API-Key: 1234567890abcdef
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `jobId` (path) | string | Sí | UUID del job a cancelar |

**Respuesta `202 Accepted`:**

```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "canceled"
}
```

**Respuesta `404 Not Found`:**

```json
{
  "error": "Job no encontrado",
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Respuesta `409 Conflict` (job existe pero no está en ejecución):**

```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "completed",
  "error": "No se puede cancelar un job que no está en ejecución"
}
```

> **Nota:** Solo se pueden cancelar jobs con `status: "processing"`. Jobs completados, fallidos o cancelados no pueden cancelarse nuevamente.

---

## 6. Modelo de Datos de Jobs

### 6.1 Estados posibles

| Estado | Descripción |
|--------|-------------|
| `"pending"` | Job creado pero aún no iniciado |
| `"processing"` | Job en ejecución activa |
| `"completed"` | Job finalizado exitosamente |
| `"failed"` | Job que terminó con error |
| `"canceled"` | Job cancelado por el usuario |

### 6.2 Estructura de un Job

```typescript
type Job = {
  jobId: string;                          // UUID v4
  status: "pending" | "processing" | "completed" | "failed" | "canceled";
  fechaDesde: string;                     // Fecha de inicio (yyyy-MM-dd)
  batchSize: number;                      // Tamaño de lote efectivo
  periodosProcesados: number;             // Períodos procesados (en curso) o totales (finalizado)
  movimientosProcesados: number;          // Movimientos procesados (en curso) o totales (finalizado)
  movimientosCuentaProcesados: number;    // Movimientos de cuenta procesados (en curso) o totales (finalizado)
  tiempoTotalMs: number;                  // Tiempo transcurrido en ms (en curso) o total (finalizado)
  eta?: string;                           // Tiempo estimado restante (solo durante procesamiento)
  error?: string;                         // Mensaje de error (solo si status es "failed" o "canceled")
  createdAt: Date;                        // Fecha/hora de creación
  updatedAt: Date;                        // Fecha/hora de última actualización
  resultado?: {                           // Solo presente si status es "completed"
    periodosProcesados: number;
    movimientosProcesados: number;
    movimientosCuentaProcesados: number;
    tiempoTotalMs: number;
    eta?: string;
  };
};
```

### 6.3 Almacenamiento de Jobs

Los jobs se almacenan usando un sistema con **fallback**:

1. **FileBackedJobService** (primario): Persiste todos los jobs en un archivo JSON (`logs/jobs-store.json` por defecto, sobrescribible con `SALDOS_JOB_STORE_PATH`). Máximo 1000 jobs.
2. **InMemoryJobService** (fallback): Si el almacenamiento en archivo falla, se usa memoria. Máximo 100 jobs.

Ambos servicios realizan limpieza automática de jobs con más de 24 horas de antigüedad.

---

## 7. Flujo de Procesamiento

### 7.1 Flujo general de `POST /api/v1/saldos/procesar`

```
1. Validar cuerpo de la solicitud (Zod schema)
2. Recortar batchSize al rango [1000, 10000]
3. Verificar que no exista un job en "processing" (409 si existe)
4. Generar UUID para jobId
5. Crear job con status "pending"
6. Iniciar procesamiento en segundo plano:
   a. Consultar la tabla saldos_contables_periodos:
      - Filtrar periodos cuyo periodoInicio >= fechaDesde
      - Ordenar por nombre ASC (campo único)
      - Identificar el primer periodo que cumple la condición
      - Si no se encuentra ninguno, lanzar error "No se encontraron periodos con periodoInicio >= {fecha}"
   b. Llamar a ProcesarSaldosContablesUseCase.execute() con la lista ordenada de periodos
   c. Actualizar estado/progress periódicamente (cada ~2 segundos)
   d. Verificar si el job fue cancelado
7. Actualizar job final con status: "completed", "failed" o "canceled"
```

### 7.2 Algoritmo de cálculo de saldos

Determinación de periodos a procesar:

1. **Buscar periodo de inicio**: Se consulta la tabla `saldos_contables_periodos`, se filtran los periodos cuyo `periodoInicio >= fechaDesde` y se ordenan por `nombre` (campo único) de forma ascendente.
2. **Identificar primer periodo válido**: Se toma el primer periodo del resultado ordenado cuyo `periodoInicio` sea mayor o igual a `fechaDesde`.
3. **Procesar todos los periodos siguientes**: A partir del periodo identificado, se procesan **todos** los periodos restantes de la tabla (ya ordenados por nombre), independientemente de si tienen movimientos contables o no.

Orden de procesamiento: **por `nombre` del periodo** (no por `id`).

Para cada período (en orden):

1. **Cero-inicializar** todos los saldos del período (todos los campos a 0).
2. **Obtener saldos del período anterior** (si no es el primer período procesado):
   - `SaldoInicialDebito = saldoFinalDebito del período anterior`
   - `SaldoInicialCredito = saldoFinalCredito del período anterior`
3. **Procesar movimientos en lotes** (batchSize, entre 1000 y 10000):
   - Agrupar cuentas por movimiento.
   - Acumular `debito` y `credito` por cuenta.
4. **Calcular saldos finales** del período:
   - `SaldoFinalDebito = SaldoInicialDebito + suma(debito)`
   - `SaldoFinalCredito = SaldoInicialCredito + suma(credito)`
5. **Actualizar saldos en base de datos** de forma masiva.
6. **Reportar progreso** (periodosProcesados, movimientosProcesados, tiempo estimado).

### 7.3 Formulas de cálculo

```
SaldoInicialDebito      = priorSaldo?.saldoFinalDeito  ?? 0
SaldoInicialCredito     = priorSaldo?.saldoFinalCredito ?? 0
SaldoFinalDebito        = SaldoInicialDebito + saldo.debito
SaldoFinalCredito       = SaldoInicialCredito + saldo.credito
```

---

## 8. Variables de Entorno

Además de las variables de configuración principales (sección 2.2), existen las siguientes variables de entorno para ajustar el comportamiento:

| Variable | Uso | Valor por defecto |
|----------|-----|-------------------|
| `SALDOS_JOB_STORE_PATH` | Ruta del archivo de jobs persistentes | `"logs/jobs-store.json"` |
| `SALDOS_PROGRESS_PERCENT_STEP` | Frecuencia de reporte de progreso en porcentaje | `5` (cada 5%) |
| `SALDOS_BATCH_LOG_STEP` | Frecuencia de log por lotes procesados | `10` (cada 10 lotes) |

---

## 9. Ejemplos de Consumo

### 9.1 curl — Preview

```bash
curl -X POST http://localhost:3000/api/v1/saldos/preview \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 1234567890abcdef" \
  -d '{
    "fechaDesde": "2024-01-01"
  }'
```

### 9.2 curl — Procesar

```bash
curl -X POST http://localhost:3000/api/v1/saldos/procesar \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 1234567890abcdef" \
  -d '{
    "fechaDesde": "2024-01-01",
    "batchSize": 5000
  }'
```

Respuesta inmediata (202):

```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "pending",
  "fechaDesde": "2024-01-01",
  "batchSize": 5000
}
```

### 9.3 curl — Monitorear progreso

```bash
curl http://localhost:3000/api/v1/saldos/status/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "X-API-Key: 1234567890abcdef"
```

### 9.4 curl — Listar jobs

```bash
# Todos los jobs
curl http://localhost:3000/api/v1/saldos/jobs \
  -H "X-API-Key: 1234567890abcdef"

# Filtrar por estado
curl "http://localhost:3000/api/v1/saldos/jobs?status=completed&limit=20" \
  -H "X-API-Key: 1234567890abcdef"

# Métricas
curl http://localhost:3000/api/v1/saldos/jobs/metrics \
  -H "X-API-Key: 1234567890abcdef"
```

### 9.5 curl — Cancelar job

```bash
curl -X POST http://localhost:3000/api/v1/saldos/cancel/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "X-API-Key: 1234567890abcdef"
```

### 9.6 JavaScript/TypeScript (fetch)

```typescript
const API_KEY = "1234567890abcdef";
const BASE_URL = "http://localhost:3000";

// Preview
const preview = await fetch(`${BASE_URL}/api/v1/saldos/preview`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
  },
  body: JSON.stringify({ fechaDesde: "2024-01-01" }),
});
const result = await preview.json();
console.log(result.periodosCount, "períodos serán procesados");

// Procesar
const procesar = await fetch(`${BASE_URL}/api/v1/saldos/procesar`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
  },
  body: JSON.stringify({ fechaDesde: "2024-01-01", batchSize: 5000 }),
});
const { jobId, status } = await procesar.json();

// Monitorear (polling)
const poll = setInterval(async () => {
  const job = await fetch(
    `${BASE_URL}/api/v1/saldos/status/${jobId}`,
    { headers: { "X-API-Key": API_KEY } }
  ).then((r) => r.json());

  console.log(
    `Progreso: ${job.periodosProcesados} períodos, ${job.movimientosProcesados} movimientos`
  );

  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
    clearInterval(poll);
    console.log("Estado final:", job.status);
  }
}, 2000);
```

---

## 10. Swagger UI

La documentación interactiva de la API está disponible en:

```
http://localhost:3000/documentation
```

Permite explorar todos los endpoints, schemas de request/response y probar las llamadas directamente desde el navegador.

La documentación OpenAPI se genera automáticamente con `@fastify/swagger` y se sirve con `@fastify/swagger-ui`.

---

## 12. Tabla `saldos_contables_periodos`

### 12.1 Descripción

La tabla `saldos_contables_periodos` almacena los periodos contables que definen el orden y rango de fechas para el procesamiento de saldos. Es consultada al inicio de cada procesamiento para determinar qué periodos procesar.

### 12.2 Campos

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | BigInt (autoincrement) | Identificador único del periodo |
| `nombre` | VARCHAR(255) | Nombre único del periodo (ej: "2024-01", "Enero"). Se usa para ordenar |
| `periodoinicio` | DATE | Fecha de inicio del periodo. Se usa para filtrar desde `fechaDesde` |
| `periodofin` | DATE | Fecha de fin del periodo |
| `cierre` | Boolean | Indica si el periodo está cerrado (default: true) |
| `cierreanio` | Boolean | Indica cierre de año (default: false) |
| `cierrecontable` | Boolean | Indica cierre contable (default: false) |
| `recalculologico` | Boolean | Indica si se debe recalcular con lógica especial |
| `created_at` | TIMESTAMP | Fecha de creación |
| `updated_at` | TIMESTAMP | Fecha de última actualización |
| `usuariocreacion_id` | BigInt | ID del usuario que creó el registro |
| `usuariomodificacion_id` | BigInt | ID del usuario que modificó el registro |

### 12.3 Relación con el procesamiento

Al ejecutar `POST /api/v1/saldos/procesar` con `fechaDesde`:

1. Se consulta `saldos_contables_periodos` ordenando por `nombre ASC`.
2. Se identifica el primer periodo cuyo `periodoinicio >= fechaDesde`.
3. Se procesan todos los periodos desde ese punto en adelante, **ordenados por `nombre`**.
4. Si no se encuentra ningún periodo con `periodoinicio >= fechaDesde`, se retorna un error `500` con el mensaje: `"No se encontraron periodos con periodoInicio >= {fecha}"`.

### 12.4 Ejemplo de datos

| id | nombre | periodoinicio | periodofin | cierre |
|----|--------|---------------|------------|--------|
| 10 | 2024-01 | 2024-01-01 | 2024-01-31 | false |
| 20 | 2024-02 | 2024-02-01 | 2024-02-29 | false |
| 30 | 2024-03 | 2024-03-01 | 2024-03-31 | false |

Si se procesa con `fechaDesde: "2024-01-15"`, solo se incluirían los periodos 20 y 30 (el 10 tiene `periodoinicio: 2024-01-01` que es anterior a `2024-01-15`).

---

## 13. Referencias Rápidas

### Resumen de endpoints

| # | Método | Ruta | Auth | Descripción |
|---|--------|------|------|-------------|
| 1 | `GET` | `/health` | No | Estado básico |
| 2 | `GET` | `/health/detailed` | No | Estado con DB |
| 3 | `GET` | `/health/metrics` | No | Métricas operativas |
| 4 | `POST` | `/api/v1/saldos/preview` | Sí | Dry-run |
| 5 | `POST` | `/api/v1/saldos/procesar` | Sí | Iniciar procesamiento |
| 6 | `GET` | `/api/v1/saldos/status/:jobId` | Sí | Estado de job |
| 7 | `GET` | `/api/v1/saldos/jobs` | Sí | Lista de jobs |
| 8 | `GET` | `/api/v1/saldos/jobs/metrics` | Sí | Métricas de jobs |
| 9 | `POST` | `/api/v1/saldos/cancel/:jobId` | Sí | Cancelar job |

### Límites y configuraciones

| Parámetro | Rango | Valor por defecto |
|-----------|-------|-------------------|
| `batchSize` | 1000 – 10000 | 5000 (configurable) |
| `limit` (listJobs) | — | 50 |
| Jobs máx (file-backed) | 1000 | — |
| Jobs máx (in-memory) | 100 | — |
| Limpieza automática | 24 horas | — |
| Reporte de progreso | 2000ms | — |
