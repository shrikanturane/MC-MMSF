# MCMF — Multi-Cloud Management Framework

A standalone full-stack multi-cloud management platform. Six operator-facing
dashboards backed by a real REST API and a PostgreSQL database.

> This app is **self-contained** — it is not the 24-phase monorepo at
> `C:\Projects\MCMF`. It implements the attached UI designs against its own
> backend and database.

## Screens

| Screen | Route | Backend module |
|---|---|---|
| Multicloud Management | `/` | `management` |
| Multicloud Monitoring | `/monitoring` | `monitoring` |
| Multicloud Security | `/security` | `security` |
| Cloud Inventory | `/inventory` | `inventory` |
| Command Center | `/command-center` | `command-center` |
| Settings | `/settings` | `settings` |

## High-level architecture

```
┌──────────────┐      HTTP/JSON       ┌──────────────┐     Prisma      ┌────────────┐
│  Next.js web │ ───────────────────▶ │  NestJS API  │ ──────────────▶ │ PostgreSQL │
│  (App Router)│ ◀─────────────────── │  (REST)      │ ◀────────────── │            │
└──────────────┘   TanStack Query     └──────────────┘                 └────────────┘
   :3000                                   :4000                            :5432
```

- **web** renders the dashboards. Data fetching is centralized in
  `web/src/lib/api.ts` and consumed through TanStack Query hooks per feature.
- **api** is a thin REST layer. Each screen maps to one module that aggregates
  the DB into a single screen-shaped response (`GET /api/<area>/overview`),
  plus list endpoints for tables.
- **db** holds the canonical model. A Prisma seed populates realistic
  multi-cloud data (accounts, resources, metrics, findings, incidents, etc.).

## Data model (Prisma)

- `CloudAccount` — a connected provider account (AWS/Azure/GCP/Private).
- `Resource` — a discovered resource (compute/storage/network/database/...),
  with live `cpuPct`, `memoryPct`, `monthlyCost`, `status`, `region`.
- `MetricPoint` — hourly fleet-wide aggregate (avg cpu/mem, network Gbps) for
  the monitoring + command-center charts.
- `SecurityFinding` — vulnerabilities, misconfigurations, and threats with
  severity + status.
- `ComplianceFramework` — CIS/SOC2/ISO27001/HIPAA/PCI/NIST scores.
- `Incident` / `Alert` — operational events for the command center.
- `AutomationWorkflow` — automation runbooks shown in the command center.
- `Integration` — Slack/PagerDuty/Webhook connectors (settings).
- `OrgSettings` — single-row org/profile/branding/customization config.

## API surface

```
GET    /api/management/overview          KPIs, provider distribution, cost allocation, governance
GET    /api/management/accounts          cloud accounts table

GET    /api/monitoring/overview          avg cpu/mem/net, service health, top consumers
GET    /api/monitoring/timeseries        hourly metric points (cpu|memory|network)
GET    /api/monitoring/incidents         incident timeline

GET    /api/security/overview            counts, findings-by-provider, frameworks, recent threats, top exposed
GET    /api/security/findings            findings table

GET    /api/inventory/resource-types     sidebar counts
GET    /api/inventory/resources          resources table (filter by provider/type/q)

GET    /api/command-center/overview      alerts, incidents, live metrics, AI engine, workflows, consumers

GET    /api/settings                     org/profile/connections/integrations/customization
PATCH  /api/settings                     update org settings
```

## Repository layout

```
mcmf/
  docker-compose.yml         postgres + api + web
  ARCHITECTURE.md
  README.md
  api/                       NestJS + Prisma
    prisma/schema.prisma
    prisma/seed.ts
    src/modules/<area>/      controller + service per screen
  web/                       Next.js App Router
    src/app/<route>/page.tsx
    src/features/<area>/     hooks + view per screen
    src/components/          shared UI (cards, charts, nav, chrome)
    src/lib/                 api client, design tokens
```

## Running locally

```bash
docker compose up --build      # postgres + api (4000) + web (3000)
# api container runs: prisma migrate deploy && prisma db seed && nest start
# open http://localhost:3000
```

See `README.md` for environment variables and dev workflow.
