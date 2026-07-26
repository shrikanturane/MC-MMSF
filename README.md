# MCMF — Multi-Cloud Management Framework

A self-contained, full-stack platform to **manage, monitor, secure, automate and
operate** resources across **AWS, Azure, GCP, Docker and private/on-prem** hosts —
from a single console. What began as six operator dashboards has grown into a broad
control plane: real cloud connectors, an endpoint agent fleet, attended remote
support, multi-cloud replication/DR, FinOps, an on-box AI engine, and more — all
backed by a real REST API, PostgreSQL, and (optionally) ClickHouse.

![stack](https://img.shields.io/badge/stack-Next.js%20%C2%B7%20NestJS%20%C2%B7%20Prisma%20%C2%B7%20Postgres-1e293b)
![license](https://img.shields.io/badge/license-MIT-3b82f6)
![agents](https://img.shields.io/badge/agents-Windows%20%C2%B7%20Linux-22c55e)

> Everything runs from one `docker compose up`. Nothing here calls a hosted SaaS —
> the API, database, log store, provisioning runner, remote-desktop gateway and AI
> model all run in your own containers.

---

## Table of contents

- [Highlights](#highlights)
- [Capabilities](#capabilities)
- [Screens & routes](#screens--routes)
- [Architecture](#architecture)
- [Run it (Docker)](#run-it-docker--recommended)
- [Run it (local dev)](#run-it-local-dev)
- [Configuration](#configuration)
- [Endpoint agents](#endpoint-agents)
- [Remote support](#remote-support)
- [Security posture](#security-posture)
- [API surface](#api-surface)
- [Project layout](#project-layout)
- [License](#license)

---

## Highlights

- **One console, many clouds** — AWS, Azure, GCP, Docker and SSH hosts connect with
  real credentials; MCMF discovers live resources, cost and posture.
- **Endpoint agent fleet** — lightweight Windows (PowerShell tray + SYSTEM service)
  and Linux (Python) agents report telemetry, OS inventory and posture over a pure
  **outbound** HTTPS channel (no inbound ports required).
- **Attended remote support** — watch a host's physical console in the browser, with
  **two-way audio, chat and file transfer**, an optional **consent gate**, and session
  recording — all relayed through the agent's outbound tunnel (works behind NAT).
- **Multi-cloud replication & DR** — files + database + Docker replication across VMs,
  DRBD synchronous block replication, cross-cloud IPsec VPN links, and auditable
  failover trials that measure RTO/RPO.
- **FinOps** — cost allocation by account/service/tag plus an estimated-carbon view.
- **On-box AI engine** — a local LLM (Ollama) powers root-cause analysis, log/metric
  analysis and automation suggestions; nothing leaves the box.
- **Observability** — live metrics, a dedicated ClickHouse log store (30-day TTL),
  transition-based uptime/SLA, and robust statistical anomaly detection (median + MAD).
- **Security & governance** — findings, CIEM (identity over-provisioning/drift),
  zero-trust checks, policy engine, compliance frameworks, full audit trail, and
  group-based RBAC down to the module/widget level.
- **Self-service provisioning** — a Terraform-backed service catalog provisions cloud
  resources through an isolated runner microservice.

---

## Capabilities

### Cloud management & inventory
Connect AWS / Azure / GCP / Docker / SSH, discover resources, and browse a filterable
inventory with live CPU / memory / cost. Account, region, resource and cost KPIs;
provider distribution; cost-allocation breakdowns; governance overview.

### Monitoring & observability
- **Metrics** — avg CPU / memory / network with live trends, service-health map, top consumers.
- **Logs** — an optional dedicated **ClickHouse** database (HTTP interface, 30-day TTL)
  ingests event / SIEM / audit rows for fast full-text log search.
- **Uptime & SLA** — transition-based device uptime (an outage is two rows, not a
  million samples), so SLA / availability / error-budget questions stay cheap to answer.
- **AIOps / anomaly detection** — robust **median + MAD** detectors over cohort metrics
  (not naive mean±σ), with confirm-gated notifications and an evaluation harness.
- **Network topology** — device / interface / neighbor discovery (SNMP) and a topology view.

### Security, identity & compliance
- **Findings** — vulnerabilities, misconfigurations and threats by provider/severity/status.
- **CIEM** — identity ingestion, over-provisioning and drift detection.
- **Zero-trust** — posture/access checks; **policy engine**; **compliance frameworks**.
- **Audit** — every privileged action (remote sessions, config changes, agent commands,
  chat/file transfers) is written to an immutable event log.

### FinOps
Cost distribution across accounts / services / tags with drill-down, plus an
**estimated carbon** view. A provider showing ₹0 is correct when it has no billed spend.

### AI engine (local)
A local **Ollama** model (e.g. Qwen2.5) drives **root-cause analysis**, log/metric
**analysis**, and **automation** suggestions. Provider is configurable; the on-box
default keeps all data local. RCA top-k ranking and cross-cloud correlation included.

### Automation & continuous optimization
Alerting, automation workflows, approvals (maker/checker), and a **continuous
feedback & optimization** layer that derives recommendations from live rules and can
write them back into policies / alert rules / workflows.

### Replication & disaster recovery
Primary / secondary / tertiary VM replication for multi-cloud HA — **files + database
+ Docker** engines, standalone install-on-host agents (Linux systemd & Windows
SYSTEM task), key-based SSH transport, **DRBD** synchronous block replication (RPO 0),
cross-cloud **IPsec/strongSwan VPN** links, and **failover trials** that record
RTO/RPO as auditable evidence (plus a safe simulate-failure drill).

### Service catalog & provisioning
A **Terraform**-engine catalog provisions cloud resources through an **isolated
tf-runner** microservice (plan → apply), tracked as provision jobs.

### Domains & TLS
Per-domain HTTPS via Let's Encrypt, and email **DKIM / SPF / DMARC** wired into the
mailer; a platform-domain card for the console itself.

### Endpoint agents & remote operations
See [Endpoint agents](#endpoint-agents) and [Remote support](#remote-support) below.

---

## Screens & routes

| Screen | Route | What it shows |
|---|---|---|
| **Multicloud Management** | `/` | Account/region/resource/cost KPIs, provider distribution, cost allocation, accounts, governance |
| **Monitoring** | `/monitoring` | CPU/memory/network trends, service-health map, top consumers, incident timeline |
| **Security** | `/security` | Vulnerabilities / misconfig / threats, findings by provider, compliance, recent threats |
| **Inventory** | `/inventory` | Resource-type sidebar, provider tabs, search, live resource table |
| **Command Center** | `/command-center` | Alerts, AI engine, incidents, automation workflows, agents fleet |
| **FinOps** | `/finops` | Cost distribution + drill-down, estimated carbon |
| **AI Engine** | `/ai` | RCA, analysis, anomalies, automation, validation |
| **Replication / DR** | `/replication` | Replication sets, DRBD/VPN links, failover trials (RTO/RPO) |
| **Service Catalog** | `/catalog` | Terraform templates → provision jobs |
| **Network** | `/network` | SNMP device/interface/neighbor view |
| **Topology** | `/topology` | Live topology graph |
| **Connections** | `/connections` | AWS/Azure/GCP/Docker/SSH connections — Test, then Sync |
| **Approvals** | `/approvals` | Maker/checker queue |
| **Reports** | `/reports` | Generated reports |
| **Activity** | `/activity` | Audit / event stream |
| **Governance** | `/governance` | Policies, compliance posture |
| **Console** | `/console` | Browser RDP/SSH via the outbound agent tunnel |
| **VMs** | `/vms` | Managed hosts / agents |
| **Custom / Board** | `/custom` | Resizable widget board (dashboards are widget catalogs) |
| **Settings** | `/settings` | Profile, connections, groups/RBAC, integrations, system parameters, database, domains, branding |
| **Help** | `/help` | In-app documentation |

Most module pages can be used as a **resizable widget board** — panels are registered
in a widget catalog and can be composed into custom dashboards.

---

## Architecture

- **Frontend** — Next.js 15 (App Router) · TypeScript · Tailwind CSS · TanStack Query · Recharts
- **Backend** — NestJS 10 · Prisma 5 · PostgreSQL 16 (58 models)
- **Log store** *(optional)* — ClickHouse 24 (HTTP interface, 30-day TTL)
- **Provisioning** *(optional)* — isolated Terraform runner microservice (`tf-runner`)
- **Remote desktop** *(optional)* — Apache Guacamole `guacd` for browser RDP/SSH
- **AI** *(optional)* — Ollama serving a local model
- **Edge** — nginx TLS reverse proxy (HTTP → HTTPS, WebSocket upgrade for media/console)
- **Agents** — Windows PowerShell tray + SYSTEM service; Linux Python daemon
- **Orchestration** — Docker Compose (one file brings up everything)

```
Browser ──HTTPS──> nginx ──> web (Next.js)
                     │
                     └──/api──> api (NestJS) ──> Postgres
                                  │  ├──> ClickHouse (logs)
                                  │  ├──> tf-runner (Terraform)
                                  │  ├──> guacd (RDP/SSH)
                                  │  └──> Ollama (AI)
                                  ▲
        agents (outbound HTTPS) ──┘   push telemetry · long-poll commands ·
                                      relay remote-support media
```

Agents never open inbound ports: they **dial out** over HTTPS to push telemetry, to
long-poll for commands, and to relay remote-support media — so a host behind NAT or a
strict firewall is fully manageable.

---

## Run it (Docker — recommended)

```bash
cd mcmf
cp .env.example .env
# REQUIRED: a strong, stable secret — seals cloud credentials + signs auth tokens.
# The API refuses to start without it.
openssl rand -hex 32   # paste the value into APP_ENCRYPTION_KEY in .env
docker compose up --build
```

This starts the full stack (db, api, web, nginx TLS proxy, plus optional
clickhouse / guacd / tf-runner / ollama / backup). The UI is served through nginx over
HTTPS — open **https://localhost** (accept the self-signed cert on first run; put your
own cert in the directory named by `CERT_DIR`).

**First login:** a default admin is created — `admin@mcmf.local` / `Admin@123`.
**Change the password immediately** in Settings → Users.

**Clean by default:** a fresh install starts empty — no sample cloud accounts. To
explore with a demo dataset, set `DEMO_SEED=1` in `.env` before first boot.

### Verify

```bash
curl -k https://localhost/api/healthz
curl -k https://localhost/api/management/overview
```

## Run it (local dev)

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

## Configuration

Key `.env` values (see `api/.env.example` for the full list):

| Variable | Purpose |
|---|---|
| `APP_ENCRYPTION_KEY` | **Required.** Seals stored cloud credentials + signs tokens. API won't start without it. |
| `DATABASE_URL` | Postgres connection string. |
| `DEMO_SEED` | `1` to load a demo dataset on first boot (default `0` = clean). |
| `CERT_DIR` | Directory holding the TLS cert/key nginx serves. |
| `CLICKHOUSE_URL` | Optional — enables the dedicated log store. |
| `AI_PROVIDER` / `OLLAMA_URL` | Selects the AI backend (local Ollama by default). |
| `ALLOW_ALL_ORIGINS` | CORS; when reflecting any origin, credentials are disabled (auth is bearer, not cookie). |

> Optional services are opt-in — if you don't set their env / don't run their
> container, MCMF degrades gracefully (e.g. no ClickHouse → logs fall back to Postgres).

## Endpoint agents

Install the agent on a Windows or Linux host to bring it under management. The agent:

- reports **telemetry** (CPU/mem/disk/net, running services), **OS inventory**
  (installed apps, listening ports, active connections) and **posture** (firewall / AV /
  encryption) on an interval you choose;
- is **pure outbound** — it dials MCMF over HTTPS to push and to long-poll for commands,
  so **no inbound firewall port** is needed;
- **auto-updates** when the server ships a newer build (single version trigger);
- carries **per-agent tokens** (issued on first check-in; the shared bootstrap key is
  only used to enroll), and fails safe if a token is revoked;
- exposes granular, **operator-revocable feature switches** (audio / chat / file
  transfer) and an **About / telemetry** panel (version, port, data sent/received,
  per-session media counters).

The Windows agent runs as a **tray app + SYSTEM service**, so it survives logoff/reboot
and can see the physical console (logon / lock / UAC screens) for remote support.

## Remote support

Attended remote control of a host's **physical console** through the browser:

- **Screen** — a persistent WebSocket media relay streams the console (fast, not the old
  one-JPEG-per-request path).
- **Two-way audio** — the operator hears the host and can talk back; loopback echo of the
  operator's own voice is cancelled, and the operator mic starts muted.
- **Chat & file transfer** — WhatsApp-style: a file offered in chat downloads on click to
  a location the user picks, with SHA-256 integrity and multipart transfer for large files.
- **Consent gate** *(admin setting)* — when on, the person at the host is asked to
  Accept/Decline; Windows Server auto-approves after a timeout, Windows 10/11 clients must
  approve or the request is cancelled.
- **Recording** and a full **audit trail** of every session and action.

A separate **console tunnel** provides browser **RDP/SSH** to private / NAT'd hosts by
routing through the same outbound agent tunnel (via `guacd`).

## Security posture

- **Fails closed** on a missing/weak `APP_ENCRYPTION_KEY` in every environment.
- **No committed secrets or key fallbacks** — every key must be supplied at runtime.
- **Constant-time** agent-key comparison; **per-agent tokens** in addition to the shared key.
- **DB-backed brute-force lockout** (holds across HA replicas); **2FA-OTP throttling**;
  password minimum length enforced.
- **SSO one-time-code** hand-off (auth token never rides in the URL).
- **CORS** sends no credentials when reflecting an arbitrary origin (auth is bearer).
- **RBAC** — group-based permissions down to module / widget / page; strict default
  (no group ⇒ no access); admins always full; API guards on sensitive controllers.
- **Command-injection hardening** on operator-reachable host/username inputs.

> Change the default admin password on first login. Supply your own TLS certificate for
> anything beyond local evaluation.

## API surface

A sample of the REST surface (all under `/api`):

```
GET   /api/management/overview          GET   /api/management/accounts
GET   /api/monitoring/overview          GET   /api/monitoring/timeseries?metric=cpu|memory|network
GET   /api/security/overview            GET   /api/security/findings?type=&severity=&status=
GET   /api/inventory/resource-types     GET   /api/inventory/resources?provider=&type=&q=
GET   /api/command-center/overview      GET   /api/finops/overview
GET   /api/agent                        POST  /api/agent/:id/pull-now
POST  /api/agent/ingest                 GET   /api/agent/commands (long-poll)
POST  /api/remote/sessions              WS    /api/remote/media/(agent|viewer)
GET   /api/replication                  POST  /api/replication/:id/failover
GET   /api/catalog                      POST  /api/catalog/:id/provision
GET   /api/settings                     PATCH /api/settings
GET   /api/healthz                      GET   /api/readyz
```

## Project layout

```
mcmf/
├── docker-compose.yml
├── ARCHITECTURE.md
├── api/                          NestJS + Prisma
│   ├── prisma/schema.prisma      data model (58 models)
│   ├── prisma/seed.ts            optional demo seed (DEMO_SEED=1)
│   └── src/
│       ├── prisma/               global PrismaService
│       ├── agent-assets/         Windows (.ps1) + Linux agents, installers, bootstrap
│       └── modules/              one module per capability (agent, remote, replication,
│                                 finops, ai, aiops, security, ciem, catalog, domains,
│                                 access, audit, uptime, …)
├── web/                          Next.js App Router
│   └── src/
│       ├── app/                  routes (one folder per screen)
│       ├── components/           shell, widgets, ui primitives, charts
│       ├── features/             one view per capability
│       └── lib/                  api client, hooks, types, helpers
└── nginx/                        TLS reverse proxy + WebSocket upgrades
```

## License

MIT — see [LICENSE](./LICENSE).
