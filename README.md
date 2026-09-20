# UML Class Designer Backend

Backend interno de la herramienta CASE. No es el backend Spring Boot exportado; genera proyectos Spring Boot descargables desde snapshots UML autorizados.

## Requisitos

- Node.js 22.12 o superior
- pnpm 11
- Docker, opcional para PostgreSQL local

## Inicio

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
docker compose up -d postgres
pnpm prisma:generate
pnpm exec prisma migrate deploy
pnpm dev
```

La API escucha por defecto en `http://127.0.0.1:3000`, expone `GET /health`, Swagger en `/docs` y OpenAPI JSON en `/docs/openapi.json`.

Las variables críticas `NODE_ENV`, `DATABASE_URL` y `AUTH_JWT_SECRET` son obligatorias. En producción también se exigen cookie `Secure`, `TRUST_PROXY_HOPS=1` y una lista explícita de `TRUST_PROXY_ADDRESSES`; el proceso escucha solo en loopback y debe publicarse mediante un único proxy inmediato de confianza. Cadenas X-Forwarded-For con más de una dirección no se usan para rate limiting del handshake Socket.IO.

## Identidad y sesiones

- Contraseñas con Argon2id; hashes y tokens nunca forman parte de las respuestas.
- JWT de acceso breve validado contra una sesión PostgreSQL activa.
- Refresh en cookie `HttpOnly`, rotado en cada uso y almacenado únicamente como SHA-256. El formato vigente incluye `sessionId`, secuencia y HMAC-SHA256; no contiene el secreto del refresh.
- La secuencia se actualiza atómicamente y un refresh anterior revoca la sesión completa, incluso bajo solicitudes concurrentes. Un token opaco legacy se acepta solo una vez durante la transición y conserva historial de replay.
- El mantenedor de sesiones inicia al arrancar y drena por lotes sesiones expiradas, su historial legacy y operaciones asociadas.
- `POST /auth/register`, `login`, `refresh` y `logout` requieren `X-Auth-Intent: 1`; solo se aceptan orígenes CORS explícitos y cuerpos JSON.

## Proyectos y documentos

`ProjectRole` contiene exclusivamente `OWNER` y `EDITOR`. El propietario administra el proyecto y sus miembros; ambos roles pueden mutar y exportar documentos UML. Un usuario sin membresía recibe 404 para recursos ajenos.

El alta de un editor exige correo normalizado y el UUID de cuenta compartido por el propio usuario. No se implementan invitaciones ni verificación de correo en este incremento.

Cada documento conserva el modelo canónico `0.1.0`, revisión actual y snapshots inmutables. `PUT` exige `expectedRevision`, ejecuta compare-and-swap atómico y devuelve 409 sin sobrescribir cuando existe conflicto. Las mutaciones REST bloquean la sesión PostgreSQL activa y la membresía dentro de su transacción, por lo que un logout o retiro concurrente gana antes de que la escritura pueda confirmar. Los IDs canónicos se normalizan de forma determinista desde los UUID persistidos; React Flow nunca se almacena como fuente de verdad. Un `PUT` activo emite `document:resync-required` a clientes autorizados y un `DELETE` los evacúa con `document:deleted`.

## Exportación Spring Boot

`POST /projects/:projectId/documents/:documentId/exports/spring-boot` requiere Bearer token y un cuerpo con `expectedRevision` y, opcionalmente, `groupId`, `artifactId`, `packageName` y `applicationName`. OWNER y EDITOR exportan; quien no pertenece al proyecto recibe 404. El servicio vuelve a consultar el documento con alcance actor/proyecto, por lo que un `projectId`/`documentId` cruzado tampoco revela información.

La exportación usa exclusivamente el snapshot canónico persistido: valida el snapshot, obtiene `RelationalModel 0.1.0`, reutiliza el generador puro y devuelve un ZIP binario determinista. No modifica el documento ni su revisión. Una revisión distinta devuelve `409 application/json` con `currentRevision`; snapshot u opciones inválidas devuelven 400. La respuesta ZIP incluye `Content-Disposition` saneado, `Content-Length`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `X-Document-Revision` y `X-Generator-Version`.

Cada ZIP contiene el proyecto Java, `openapi/generated-api.openapi.json` OpenAPI 3.1, `postman/generated-api.postman_collection.json` v2.1 y `generation-manifest.json` con hashes SHA-256. Una allowlist cerrada admite solo archivos del scaffold, OpenAPI, Postman, manifiesto y migraciones generadas; rechaza `.env`, secretos, rutas absolutas, traversal, ZIPs anidados y entradas duplicadas. El empaquetado usa `archiver@7.0.1` (MIT, CommonJS compatible con el backend) y `newman@6.2.2` (Apache-2.0) para ejecutar la colección en runtime.

Límites locales actuales: 100 tablas, 200 relaciones, snapshot de 1 MiB, 1000 archivos, 10 MiB sin comprimir, ZIP de 5 MiB, 10 segundos para generación/empaquetado, dos exportaciones concurrentes y cinco solicitudes por actor cada 60 segundos. Las entradas canónicas sobredimensionadas se rechazan antes de transformación; el seguimiento de cuota expira actores inactivos y tiene una capacidad máxima. Las claves primarias `byte[]` se rechazan explícitamente porque no existe una codificación URL de identidad canónica en esta versión. Las cuotas son locales al proceso; múltiples réplicas requerirán coordinación distribuida. No se agrega Redis en este incremento.

Para ejecutar un ZIP descargado:

```powershell
$env:DB_URL='jdbc:postgresql://127.0.0.1:5432/app'
$env:DB_USERNAME='app'
$env:DB_PASSWORD='una-clave-local'
$env:SERVER_PORT='8080'
mvn --batch-mode -DskipTests package
& "$env:JAVA_HOME\bin\java.exe" -jar target\*.jar
pnpm exec newman run postman\generated-api.postman_collection.json --env-var baseUrl=http://127.0.0.1:8080
```

La aplicación exportada ejecuta Flyway y usa `hibernate.ddl-auto=validate`; no crea ni altera el esquema fuera de las migraciones generadas.

## Contrato canónico

`contracts/uml-model.schema.json` es la única fuente de verdad contractual. Separa semántica UML de `diagram.visual.positions`, persistencia Prisma y futuro estado colaborativo. No contiene tipos React Flow.

```powershell
pnpm contracts:test
pnpm openapi:generate
pnpm openapi:check
```

## Colaboración en tiempo real

`contracts/collaboration-protocol.schema.json` define el protocolo Socket.IO `1.0.0`. El cliente debe conectarse con un access token vigente únicamente en `auth.token`; tokens en query string, cookies de refresh y snapshots completos no son parte del protocolo. El handshake exige un encabezado `Origin` presente en `CORS_ORIGINS`.

- `document:join` autoriza `OWNER`/`EDITOR`, deriva el room interno `document:<documentId>` y devuelve snapshot solo en el primer join o cuando `knownRevision` está desactualizada. Los joins del mismo socket se serializan para respetar `COLLABORATION_MAX_DOCUMENTS_PER_SOCKET`, incluso si solicitan documentos distintos en paralelo.
- `document:command` acepta uno de los 16 comandos canónicos tipados, exige `operationId` UUID y `baseRevision`, bloquea sesión y membresía dentro de la transacción CAS, persiste `DocumentOperation` y `DocumentRevision`, y emite `document:operation` (sin `ok`, solo post-commit) solamente después del commit. Los locks excluyen por socket propietario sobre todos los clasificadores modificados indirectamente, incluidos los que contienen referencias de tipo actualizadas por un renombre; otra pestaña o sesión del mismo usuario recibe `ELEMENT_LOCKED`.
- Cada evento colaborativo admite en orden identidad local, cuota por socket, AJV y sesión PostgreSQL: el exceso responde `RATE_LIMITED` y el payload inválido falla AJV sin consultar la sesión; ningún evento ejecuta lógica sin sesión activa.
- Reintentar el mismo `operationId`, actor y payload devuelve el mismo ACK sin una segunda revisión ni broadcast. Reutilizarlo con otro actor o payload devuelve `OPERATION_ID_REUSED`.
- `presence:update`, `lock:acquire`, `lock:renew` y `lock:release` trabajan solo después del join. Locks incluyen lease UUID, vencen por TTL y se liberan al salir o desconectarse el socket. El `PUT` HTTP de reemplazo se rechaza con 409 ante cualquier lock activo, incluso propio, porque HTTP no puede demostrar un lease Socket.IO.
- Antes de cada broadcast se vuelve a comprobar sesión y membresía en PostgreSQL; una sesión revocada se desconecta y una membresía retirada abandona el room antes de recibir el evento.
- Si una operación confirmada no llega a difundirse, un recuperador local la detecta mediante `broadcastedAt`, emite `document:resync-required` para la revisión actual y confirma la entrega pendiente.
- Antes de JWT/Prisma, el adapter limita intentos globales, por cliente y handshakes pendientes. Un deadline único cierra con descarte transports polling que no envían `CONNECT`; la consulta de sesión conserva su cupo hasta completar o agotar ese mismo deadline.

Presencia, locks, cola por documento y rooms son locales al proceso. La cola reserva una plaza crítica por documento para evacuaciones, resync y recuperación, y coalesce esas tareas para mantener su límite. Los sockets están acotados globalmente y por sesión. Esta versión funciona en una única réplica; una ampliación horizontal requiere adaptador Socket.IO, presencia/locks y cola compartidos, por ejemplo Redis, además de un outbox transaccional.

Variables de colaboración:

```text
COLLABORATION_SOCKET_MAX_PAYLOAD_BYTES=65536
COLLABORATION_PING_TIMEOUT_MS=20000
COLLABORATION_PING_INTERVAL_MS=25000
COLLABORATION_COMMAND_LIMIT=30
COLLABORATION_COMMAND_WINDOW_MS=10000
COLLABORATION_CONTROL_EVENT_LIMIT=60
COLLABORATION_CONTROL_EVENT_WINDOW_MS=10000
COLLABORATION_PRESENCE_MIN_INTERVAL_MS=100
COLLABORATION_LOCK_TTL_SECONDS=30
COLLABORATION_MAX_PARTICIPANTS_PER_DOCUMENT=100
COLLABORATION_MAX_DOCUMENTS_PER_SOCKET=20
COLLABORATION_MAX_CONNECTED_SOCKETS=1000
COLLABORATION_MAX_SOCKETS_PER_SESSION=5
COLLABORATION_HANDSHAKE_LIMIT=30
COLLABORATION_HANDSHAKE_GLOBAL_LIMIT=200
COLLABORATION_HANDSHAKE_WINDOW_MS=10000
COLLABORATION_HANDSHAKE_TIMEOUT_MS=10000
COLLABORATION_MAX_PENDING_HANDSHAKES=32
COLLABORATION_MAX_PENDING_MUTATIONS_PER_DOCUMENT=128
COLLABORATION_OPERATION_RECOVERY_INTERVAL_MS=1000
COLLABORATION_OPERATION_RECOVERY_BATCH_SIZE=100
```

La migración `20260908120000_add_document_operations` agrega el registro idempotente por `(documentId, operationId)`, índices de revisión y referencias a documento/actor. `20260908130000_add_document_operation_delivery` añade `broadcastedAt` y marca las operaciones históricas como ya entregadas. `20260908140000_add_document_operation_recovery_index` añade el índice parcial de operaciones aún pendientes de difusión. `20260908150000_add_auth_session_refresh_sequence` añade la secuencia de refresh. `20260914120000_correct_document_operation_broadcasted_at` convierte `broadcastedAt` a `TIMESTAMPTZ(3)` con `USING ... AT TIME ZONE 'UTC'`, determinista ante cualquier zona de sesión. Aplique siempre `pnpm exec prisma migrate deploy`; no use `db push`.

## Verificación

```powershell
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm prisma:validate
pnpm openapi:check
pnpm build
pnpm smoke:production
pnpm spring-boot:verify
```

La base E2E es exclusiva y usa PostgreSQL 17 en `127.0.0.1:55434`:

```powershell
pnpm db:test:up
pnpm test:e2e
pnpm db:test:status
pnpm db:test:down
```

La verificación runtime se mantiene separada de `pnpm verify` porque requiere Docker, PostgreSQL 17 y JDK 21 local. Crea un contenedor etiquetado y con nombre único, publica PostgreSQL y Tomcat en puertos efímeros de `127.0.0.1`, elimina temporales y no toca recursos externos. El puerto `55435` se reserva únicamente para simular el fallo controlado de puerto ocupado. El fixture puede cambiarse para repetir la matriz de UUID, tipos avanzados y relaciones:

```powershell
$env:JAVA_HOME='C:\Program Files\Java\jdk-21'
pnpm spring-boot:runtime
$env:SPRING_BOOT_RUNTIME_FIXTURE='06-uuid-pgcrypto.json'; pnpm spring-boot:runtime
$env:SPRING_BOOT_RUNTIME_FIXTURE='07-json-and-advanced-types.json'; pnpm spring-boot:runtime
$env:SPRING_BOOT_RUNTIME_FIXTURE='08-self-reference.json'; pnpm spring-boot:runtime
pnpm spring-boot:runtime:failures
pnpm package:6a3a
```

`pnpm package:6a3a` crea los cuatro ZIP corregidos y su manifiesto SHA-256 en `../entregables/6A3A`. Requiere un worktree backend limpio, toma exclusivamente `git ls-files -z`, compara ese conjunto con el directorio central del ZIP y ejecuta tres empaquetados idénticos. El empaquetador usa fecha/modo fijos, comentario EOCD trazable y rechaza paths peligrosos, `.env` real, artefactos de build, Prisma generado, binarios nativos y ZIPs anidados.

Continúan fuera de alcance la interfaz de descarga en frontend, invitaciones, OAuth, recuperación de contraseña, escalado horizontal de colaboración, IA, importación XMI y despliegue cloud.
