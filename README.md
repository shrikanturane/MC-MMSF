# MCMF — Multi-Cloud Management Framework

A self-contained full-stack platform for managing, monitoring, securing and
operating resources across AWS, Azure, GCP and private cloud. Six operator
dashboards backed by a real REST API and PostgreSQL.

![screens](https://img.shields.io/badge/screens-6-3b82f6) ![stack](https://img.shields.io/badge/stack-Next.js%20%C2%B7%20NestJS%20%C2%B7%20Prisma%20%C2%B7%20Postgres-1e293b)

> Built from the attached UI designs. See **[ARCHITECTURE.md](./ARCHITECTURE.md)**
> for the full design, data model and API surface.

## Screens

| Screen | Route | What it shows |
|---|---|---|
| **Multicloud Management** | `/` | Account/region/resource/cost KPIs, provider distribution, cost allocation donut, accounts table, governance |
| **Multicloud Monitoring** | `/monitoring` | Avg CPU/memory/network with live trends, service health map, top consumers, incident timeline |
| **Multicloud Security** | `/security` | Vulnerabilities / misconfigurations / threats, findings-by-provider, compliance frameworks, recent threats, top exposed |
| **Cloud Inventory** | `/inventory` | Resource-type sidebar, provider tabs, search, filterable resource table with live CPU/mem/cost |
| **Command Center** | `/command-center` | Active alerts, AI engine, active incidents, automation workflows, top consumers |
| **Settings** | `/settings` | Profile, cloud connections, region, branding, module toggles, integrations (live save) |

## Tech stack

- **Frontend** — Next.js 15 (App Router) · TypeScript · Tailwind CSS · TanStack Query · Recharts
- **Backend** — NestJS 10 · Prisma 5 · PostgreSQL 16
- **Infra** — Docker Compose

## Run it (Docker — recommended)

> This machine has Docker but no host Node/pnpm, so containers are the way to run it.

```bash
cd mcmf
cp .env.example .env
# REQUIRED: set a strong, stable secret (seals cloud credentials + signs auth tokens).
# The API refuses to start without it.
openssl rand -hex 32   # paste the value into APP_ENCRYPTION_KEY in .env
docker compose up --build
```

This starts the full stack (db, api, web, nginx TLS proxy, plus optional
clickhouse / guacd / tf-runner / backup). The UI is served through nginx over
HTTPS — open **https://localhost** (accept the self-signed cert on first run;
put your own cert in the directory named by `CERT_DIR`).

**First login:** a default admin is created — `admin@mcmf.local` / `Admin@123`.
**Change the password immediately** in Settings → Users.

**Clean by default:** a fresh install starts empty — no sample cloud accounts.
To explore with a demo dataset, set `DEMO_SEED=1` in `.env` before first boot.

### Verify

```bash
curl http://localhost:4000/api/healthz
curl http://localhost:4000/api/management/overview
```

## Run it (local dev, if you have Node 20)

```bash
# API
cd api
cp .env.example .env          # point DATABASE_URL at your Postgres
npm install
npx prisma db push
npm run db:seed
npm run start:dev             # http://localhost:4000/api

# Web (separate terminal)
cd web
cp .env.example .env.local
npm install
npm run dev                   # http://localhost:3000
```

## API surface

```
GET   /api/management/overview        GET   /api/management/accounts
GET   /api/monitoring/overview        GET   /api/monitoring/timeseries?metric=cpu|memory|network
GET   /api/monitoring/incidents
GET   /api/security/overview          GET   /api/security/findings?type=&severity=&status=
GET   /api/inventory/resource-types   GET   /api/inventory/resources?provider=&type=&q=
GET   /api/command-center/overview
GET   /api/settings                   PATCH /api/settings
GET   /api/healthz                    GET   /api/readyz
```

## Project layout

```
mcmf/
├── docker-compose.yml
├── ARCHITECTURE.md
├── api/                      NestJS + Prisma
│   ├── prisma/schema.prisma  data model
│   ├── prisma/seed.ts        realistic multi-cloud seed
│   └── src/
│       ├── prisma/           global PrismaService
│       └── modules/          one module per screen
└── web/                      Next.js App Router
    └── src/
        ├── app/              routes (one folder per screen)
        ├── components/       Sidebar, Topbar, ui primitives, charts
        ├── features/         one view per screen
        └── lib/              api client, hooks, types, format helpers
```
