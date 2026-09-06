# UML Class Designer Backend

Backend interno de la herramienta CASE. No es el backend Spring Boot que se generará en etapas posteriores.

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

Las variables críticas `NODE_ENV`, `DATABASE_URL` y `AUTH_JWT_SECRET` son obligatorias. En producción también se exige cookie `Secure` y `TRUST_PROXY_HOPS >= 1`; el proceso escucha solo en loopback y debe publicarse mediante un proxy de confianza.

## Identidad y sesiones

- Contraseñas con Argon2id; hashes y tokens nunca forman parte de las respuestas.
- JWT de acceso breve validado contra una sesión PostgreSQL activa.
- Refresh opaco en cookie `HttpOnly`, rotado en cada uso y almacenado únicamente como SHA-256.
- Todo refresh consumido queda registrado: su reutilización revoca la sesión completa, incluso bajo solicitudes concurrentes.
- `POST /auth/register`, `login`, `refresh` y `logout` requieren `X-Auth-Intent: 1`; solo se aceptan orígenes CORS explícitos y cuerpos JSON.

## Proyectos y documentos

`ProjectRole` contiene exclusivamente `OWNER` y `EDITOR`. El propietario administra el proyecto y sus miembros; ambos roles pueden operar documentos UML, incluida la eliminación. Un usuario sin membresía recibe 404 para recursos ajenos.

El alta de un editor exige correo normalizado y el UUID de cuenta compartido por el propio usuario. No se implementan invitaciones ni verificación de correo en este incremento.

Cada documento conserva el modelo canónico `0.1.0`, revisión actual y snapshots inmutables. `PUT` exige `expectedRevision`, ejecuta compare-and-swap atómico y devuelve 409 sin sobrescribir cuando existe conflicto. Los IDs canónicos se normalizan de forma determinista desde los UUID persistidos; React Flow nunca se almacena como fuente de verdad.

## Contrato canónico

`contracts/uml-model.schema.json` es la única fuente de verdad contractual. Separa semántica UML de `diagram.visual.positions`, persistencia Prisma y futuro estado colaborativo. No contiene tipos React Flow.

```powershell
pnpm contracts:test
pnpm openapi:generate
pnpm openapi:check
```

## Verificación

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm prisma:validate
pnpm openapi:check
pnpm build
```

La base E2E es exclusiva y usa PostgreSQL 17 en `127.0.0.1:55434`:

```powershell
pnpm db:test:up
pnpm test:e2e
pnpm db:test:status
pnpm db:test:down
```

Continúan fuera de alcance la integración funcional del frontend, verificación de correo, invitaciones, OAuth, recuperación de contraseña, colaboración Socket.IO, IA, importación/exportación y generación Spring Boot.
