# NEXUS OPERACIONAL

NEXUS OPERACIONAL is a web command center that transforms the legacy Excel workbook into a permanent industrial operations platform.

It includes production P1/P2, losses, overweight, downtime, productivity, weeks, historical archive, dashboards, reports, meeting mode, audit, imports and backups.

## Stack

- Frontend: Next.js, React, TypeScript, Tailwind CSS, ECharts, TanStack-ready structure.
- Backend: NestJS, TypeScript, Prisma, PostgreSQL, JWT auth and RBAC guards.
- Data: PostgreSQL, Prisma schema and migrations.
- Legacy import: Python scripts with safe XLSX inspection and cleaning.
- Quality: Vitest unit/integration tests and Playwright E2E.
- Infra: Docker Compose for Postgres, API and Web.

JavaScript is used only as runtime. TypeScript is the project language. Python is only for import, cleaning and migration helpers. Java, C# and C are intentionally not used.

## Local setup on Windows

PowerShell may block `npm.ps1`; use `npm.cmd`.

```powershell
cd .\nexus-operacional
npm.cmd install
Copy-Item .env.example .env
```

Before running Prisma locally, fill `POSTGRES_PASSWORD`, `DATABASE_URL`, `JWT_ACCESS_SECRET` and `INITIAL_ADMIN_PASSWORD` in `.env`. The database URL must contain the same PostgreSQL password.

```powershell
npm.cmd run prisma:generate
npm.cmd run prisma:migrate
npm.cmd run prisma:seed
npm.cmd run dev
```

If Docker is installed:

```powershell
docker compose up -d --build
```

### Deploy with Docker Compose

Create a local `.env` from the example and update secrets and public URLs:

```powershell
copy .env.example .env
```

Generate independent secrets, then place them in `.env` (the example intentionally leaves them blank):

```bash
openssl rand -hex 32
openssl rand -base64 48
openssl rand -base64 32
```

Edit `.env` and set:

- `POSTGRES_PASSWORD` to the hexadecimal value
- `JWT_ACCESS_SECRET` to the independent base64 value
- `BACKUP_ENCRYPTION_KEY` to the third, independent base64 value
- `BACKUP_EXTERNAL_HOST_DIR` to a protected NAS/remote mount owned by UID/GID `1000:1000`
- `WEB_ORIGIN` to your public frontend URL
- `NEXT_PUBLIC_API_URL` to `/api`, keeping browser requests on the same origin

`NEXT_PUBLIC_API_URL` and `API_INTERNAL_URL` are embedded while building the
web image. Rebuild `web` after changing either value.

Docker Compose constructs the API `DATABASE_URL` from `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`. A direct API deployment outside Compose must set `DATABASE_URL` explicitly with a strong database password.

Compose stops before creating containers when a required secret, `WEB_ORIGIN` or the external backup path is empty. The API also refuses to start with `NODE_ENV=production` when the JWT secret, database password, Web origin or backup key is missing, malformed, insecure or resembles a known placeholder. Production cookies accept only `SameSite=Lax/Strict`, and unsafe browser requests must come from the configured same origin. Development keeps its isolated fallback only when `NODE_ENV` is not `production`.

Build the images and start PostgreSQL first. Keep API/Web stopped while the schema changes:

```powershell
docker compose build api web
docker compose stop web api
docker compose up -d postgres
```

Apply Prisma migrations and the clean operational bootstrap in one-off API containers, then start the application:

```powershell
docker compose run --rm api npm run prisma:deploy
docker compose run --rm --env-from-file .env.bootstrap api npm run prisma:seed
docker compose run --rm --env-from-file .env.bootstrap api npm run bootstrap:assert-clean
```

Do not start API/Web yet. Complete the encrypted backup, external checksum and disposable-database restore proof in `docs/production-deploy.md`. Only after `RESTORE_PROOF_PASSED` may you run `docker compose up -d --wait --wait-timeout 180 api web`.

Copy `.env.bootstrap.example` to a mode-`0600` `.env.bootstrap`; it contains only `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD`, `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_ROTATE_PASSWORD` and optional `COMPANY_NAME`, and is ignored by Git. The default seed creates only that administrator, RBAC permissions/roles and the optional company name. It never creates products, goals, weeks or operational records. Bootstrap credentials are injected only into that disposable seed container; remove the password from `.env.bootstrap` after the first verified login. Re-running the seed for an existing administrator does not require or rotate that password. Demo catalog data is isolated in `prisma/seed-demo.ts`, refuses production mode and is not part of normal deployment.

Starting from zero requires a new, empty PostgreSQL database/volume. The seed is intentionally non-destructive and never erases an existing database. `bootstrap:assert-clean` checks every application table; it permits only one active administrator, RBAC rows and the optional `company` setting, and aborts if any master, operational, import, audit, report, snapshot or backup row already exists.

Run `bootstrap:assert-clean` only on the first empty deployment. Updates to a database with real data must create and prove a native encrypted backup before migrations, then skip that clean-bootstrap assertion. The controlled upgrade sequence is documented in `docs/production-deploy.md`.

If you need a lightweight production deployment on the same host, you can keep using the same `docker-compose.yml` with the production values in `.env`.

## Public demo deployment

The repository includes a GitHub Actions workflow for a static public demo only. It validates the Chromium preview and updates automatically from `main` and the homologation branch. It must not be used as the operational deployment for real company data.

- Frontend build: `NEXUS_STATIC_DEMO=true NEXT_PUBLIC_DEMO_MODE=true npm run build --workspace=@nexus/web`
- Pages artifact: `apps/web/out`

When the manual workflow is approved and GitHub Pages is enabled for this repository, the demo frontend will be published at:

```text
https://rafaelrfl0900-ship-it.github.io/nexus-operacional/
```

> Note: this GitHub Pages deployment publishes the frontend only and cannot be used for the real authenticated operation.

For a full production deployment with API + PostgreSQL, host the repository on a server or a managed platform such as Render, Railway or a VPS, then use the current `docker-compose.yml` and `.env` values.

See `docs/production-deploy.md` for a step-by-step production deployment guide.

## Important URLs

- Web: `http://localhost:3000`
- API pelo frontend Docker: `http://localhost:3000/api`
- API direta local: `http://localhost:3333/api`
- Health publico minimo: `http://localhost:3000/api/health`

## Initial admin

- Email: value from `INITIAL_ADMIN_EMAIL`
- Password: value from `INITIAL_ADMIN_PASSWORD`

Set a unique strong password in the ignored, mode-`0600` `.env.bootstrap` before the first seed and save it in a password manager. The bootstrap enforces the same password policy as user administration. Remove `INITIAL_ADMIN_PASSWORD` from that file after the first verified login. Re-running the seed preserves an existing password without needing that variable; intentional rotation requires a new value plus `INITIAL_ADMIN_ROTATE_PASSWORD=true` and revokes prior sessions.

## Legacy workbook import

The scripts tolerate invalid cells and formula errors such as `#N/A`, `#REF!`, `#DIV/0!` and `#VALUE!`.

In the operational app, workbook import must go through the authenticated upload flow at `/api/import/upload`. The browser no longer sends arbitrary server file paths; the API stores the XLSX privately, calculates SHA-256 and creates an auditable import batch.

```powershell
$xlsx = Get-ChildItem $env:USERPROFILE\Downloads -Filter '*MAIO*2026*(9).xlsx' | Select-Object -First 1 -ExpandProperty FullName
npm.cmd run import:excel -- --file $xlsx --report import-report.json
npm.cmd run migrate:legacy -- --report import-report.json
```

The importer now emits `legacyData.products`, a normalized product catalog merged from `Pacotes-caixas` and `Banco de Dados Pesagen`. In the supplied workbook it currently identifies 87 product/config rows and flags the known duplicated weighing codes `70974`, `73735`, `76379` and `76678`.

## Project structure

```txt
nexus-operacional/
  apps/
    api/   NestJS API
    web/   Next.js application
  prisma/  schema, migrations and seed
  scripts/ Excel import/clean/migration helpers
  tests/   unit, integration and e2e tests
  docs/    calculation rules and operational notes
```

## Acceptance coverage

Implemented foundation:

- P1/P2 production forms and backend calculation service.
- Protected yield and overweight calculation.
- Losses, downtime, productivity, goals, reports, presentations, audit, imports and backups modules.
- Weekly period model with close/reopen/archive actions.
- Permanent historical model with soft delete fields and audit logs.
- Dashboard with KPIs and ECharts visualizations.
- Python workbook inspection and safe data cleaning.
- Normalized product extraction from the workbook, with import errors ready for `import_errors`.
- JWT guard and RBAC metadata on protected API routes.
- Login screen connected to `/api/auth/login`.
- P1/P2 form calculation preview connected to `/api/production/preview`.
- Unit tests for production and downtime calculation.
- Unit tests for auth/RBAC guards.
- Clean production bootstrap: RBAC and the configured administrator only, with no operational records.
- Protected base-data administration for sectors, production lines, loss types and downtime reasons.
- Versioned approval workflows for production, losses, downtime, dosage and productivity.
- Human governance for ambiguous calculation rules; dependent approvals fail closed.
- Atomic mutation/audit boundaries for the central operational and user-management flows.
- Encrypted backup creation and destructive-operation-safe restore proof in a separate empty PostgreSQL database.
- Operational end-to-end flow with independent submitter/approver roles, weekly close, reports, snapshot, reopen and audit evidence.

Release boundary:

- GitHub Pages is a public static demo and never an operational deployment.
- Daily production use requires a provisioned host/domain/TLS certificate, PostgreSQL, external backups, monitoring and environment-specific restore exercise.
- Replacing Excel requires the original workbook to be reconciled again, human approval of ambiguous formulas and a successful parallel-operation period.
- The workbook named in the audit is not currently present in this workspace, so final spreadsheet certification remains blocked until it is attached again.

See [`docs/go-live-readiness-2026-08-01.md`](docs/go-live-readiness-2026-08-01.md) for the explicit release gate, [`docs/current-status.md`](docs/current-status.md) for the dated technical status and [`docs/production-deploy.md`](docs/production-deploy.md) for deployment controls.
