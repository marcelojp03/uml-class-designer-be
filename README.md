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
pnpm dev
```

La API escucha por defecto en `http://127.0.0.1:3000`, expone `GET /health`, Swagger en `/docs` y OpenAPI JSON en `/docs/openapi.json`.

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

No se incluyen aún autenticación, CRUD de proyectos, colaboración Socket.IO ni generación Spring Boot.
