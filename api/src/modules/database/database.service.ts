import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { sysParams, pInt } from '../../system-params';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sshRun, sshWriteFile, sshPutFile, shq } from './ssh-deploy';
import { encryptJson, decryptJson } from '../../connectors/crypto';
import { createHash } from 'node:crypto';
import { ApprovalGate, type GateActor } from '../approvals/approval-gate.service';
import { CH_DB, chInsertRows, chQuery } from '../../common/clickhouse';

const execFileP = promisify(execFile);
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const ENV_ROLES = ['development', 'test', 'production']; // server/node environment roles

// ── Dev → Prod selective sync classification ──────────────────────────────
// Config/logic you build on dev and promote to prod. These have NO incoming FK (verified), so
// replacing their data can't orphan prod's operational rows. Prod's identity/2FA, cloud
// connections, discovered resources, agents, credentials, integrations and history are PRESERVED
// (never in this list) — that fixes the "2FA re-prompt" + "prod VMs disappear" problems.
/** Written on the TARGET after a verified successful rebuild — the source of truth for "what does prod
 *  actually run?". The skip-the-rebuild check reads THIS, never a hash held on the deploying server. */
const DEPLOY_MARKER = '~/mcmf/.mcmf-deployed-hash';

const CONFIG_REPLACE_TABLES = [
  'AlertRule', 'AutomationWorkflow', 'EscalationPolicy', 'Policy', 'ApprovalPolicy',
  'ComplianceFramework', 'ComplianceItem', 'DashboardLayout', 'Report', 'Budget',
  'NotificationChannel', 'Asset',
];
// OrgSettings columns promoted dev→prod (branding/modules/layout/posture); env-identity columns
// (envLabel, clusterCname, provisioningEnabled, id, updatedAt) are deliberately PRESERVED on prod.
const ORG_SYNC_COLS = ['orgName', 'userName', 'userEmail', 'userRole', 'timezone', 'dateFormat', 'currency', 'language', 'primaryColor', 'tagline', 'theme', 'logo', 'bgImage', 'logRetentionDays', 'blocklistEnabled', 'countryMode', 'require2fa'];
const ORG_SYNC_JSON_COLS = ['modules', 'layout', 'accessBlocklist', 'countryList'];
// Log/telemetry tables — highlighted in the UI so growth is visible.
const LOG_TABLES = new Set(['AuditLog', 'EventLog', 'SiemEvent', 'NotificationLog', 'MetricPoint']);

// ── ClickHouse log database (next-phase log analytics store) ──────────────
// HTTP client lives in common/clickhouse.ts (shared with the aiops metrics store).
const LOG_TTL_DAYS = Number(process.env.LOG_TTL_DAYS || 30);
const LOG_SOURCES = ['event', 'siem', 'audit'] as const;
type LogSource = (typeof LOG_SOURCES)[number];

function dbConn() {
  const url = process.env.DATABASE_URL || '';
  const m = /postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:/]+)(?::(\d+))?\/(\w+)/.exec(url);
  if (!m) return null;
  return { user: m[1], pass: m[2], host: m[3], port: m[4] || '5432', db: m[5] };
}

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly log = new Logger('Database');
  private chReady = false;
  private syncing = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalGate: ApprovalGate,
  ) {}

  /** Provision the ClickHouse log store, backfill, then keep it synced from Postgres. */
  async onModuleInit() {
    setTimeout(() => void this.ensureClickHouse().then(() => this.syncLogs()).catch((e) => this.log.warn(`ClickHouse init deferred: ${String((e as Error)?.message ?? e)}`)), 10_000);
    setInterval(() => void this.syncLogs().catch(() => undefined), 60_000);
  }

  // ── ClickHouse client (HTTP interface, shared helper) ───────────────────
  private async ch(sql: string, json = false): Promise<any> {
    return chQuery(sql, json);
  }
  private async chInsert(rows: Record<string, any>[]): Promise<void> {
    return chInsertRows(`${CH_DB}.logs`, rows);
  }

  /** Idempotently create the log database + TTL table. The TTL is operator-tunable (Settings → System
   *  Parameters → Log retention); a change is applied here via ALTER on the next (re)init. */
  async ensureClickHouse() {
    const ttlDays = pInt(await sysParams(this.prisma), 'logTtlSettingDays', 'LOG_TTL_DAYS', LOG_TTL_DAYS);
    await this.ch(`CREATE DATABASE IF NOT EXISTS ${CH_DB}`);
    await this.ch(
      `CREATE TABLE IF NOT EXISTS ${CH_DB}.logs (` +
        `ts DateTime, source LowCardinality(String), level LowCardinality(String), ` +
        `category LowCardinality(String), host String, actor String, provider LowCardinality(String), ` +
        `message String, detail String, pg_id String` +
        `) ENGINE = ReplacingMergeTree ORDER BY (ts, source, pg_id) ` +
        `TTL ts + INTERVAL ${ttlDays} DAY SETTINGS index_granularity = 8192`,
    );
    // Keep the TTL in step with the setting if it changed since the table was created (best-effort).
    await this.ch(`ALTER TABLE ${CH_DB}.logs MODIFY TTL ts + INTERVAL ${ttlDays} DAY`).catch(() => undefined);
    if (!this.chReady) this.log.log(`ClickHouse log store ready (${CH_DB}.logs, ${ttlDays}d TTL)`);
    this.chReady = true;
  }

  private fmtTs(d: any): string {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString().slice(0, 19).replace('T', ' ');
  }
  private mapLog(src: LogSource, r: any): Record<string, any> {
    const base = { ts: this.fmtTs(r.ts), source: src, pg_id: String(r.id ?? ''), level: '', category: '', host: '', actor: '', provider: '', message: '', detail: '' };
    if (src === 'event') return { ...base, level: r.severity ?? '', category: r.type ?? '', host: r.resourceName ?? '', provider: r.provider ?? '', message: r.title ?? '', detail: r.detail ?? '' };
    if (src === 'siem') return { ...base, level: r.level ?? '', category: r.category ?? '', host: r.host ?? '', message: r.message ?? '', detail: typeof r.raw === 'string' ? r.raw.slice(0, 500) : r.raw ? JSON.stringify(r.raw).slice(0, 500) : '' };
    return { ...base, level: r.action ?? '', category: 'audit', actor: r.actorEmail ?? '', host: r.ip ?? '', message: r.action ?? '', detail: r.detail ?? '' };
  }

  private async chWatermark(src: LogSource): Promise<string> {
    try {
      const v = String(await this.ch(`SELECT toString(max(ts)) FROM ${CH_DB}.logs WHERE source='${src}'`)).trim();
      return v && !v.startsWith('1970') && v !== '0000-00-00 00:00:00' ? v : '1970-01-01 00:00:00';
    } catch {
      return '1970-01-01 00:00:00';
    }
  }
  private async pgLogs(src: LogSource, wm: string): Promise<any[]> {
    const q = (sql: string) => this.prisma.$queryRawUnsafe<any[]>(sql);
    const since = `'${wm}'`;
    if (src === 'event') return q(`select id, ts, severity, type, "resourceName", provider, title, detail from "EventLog" where ts >= ${since} order by ts asc limit 20000`);
    if (src === 'siem') return q(`select id, ts, level, category, host, message, raw from "SiemEvent" where ts >= ${since} order by ts asc limit 20000`);
    return q(`select id, ts, action, "actorEmail", ip, detail from "AuditLog" where ts >= ${since} order by ts asc limit 20000`);
  }

  /** Pull new rows from each Postgres log table into ClickHouse (incremental, dedup by ReplacingMergeTree). */
  async syncLogs(): Promise<{ inserted: number } | null> {
    if (!this.chReady) { await this.ensureClickHouse().catch(() => undefined); if (!this.chReady) return null; }
    if (this.syncing) return null;
    this.syncing = true;
    let inserted = 0;
    try {
      for (const src of LOG_SOURCES) {
        const wm = await this.chWatermark(src);
        const rows = await this.pgLogs(src, wm);
        if (!rows.length) continue;
        const chRows = rows.map((r) => this.mapLog(src, r));
        for (let i = 0; i < chRows.length; i += 5000) await this.chInsert(chRows.slice(i, i + 5000));
        inserted += chRows.length;
      }
    } finally {
      this.syncing = false;
    }
    return { inserted };
  }

  /** Status of the ClickHouse log store for the Database panel (status, retention/TTL, sync). */
  async logStoreStatus() {
    const out: any = { engine: 'ClickHouse', role: 'Log analytics store', ok: false, mode: 'standalone', rows: 0, size: '—', retentionDays: LOG_TTL_DAYS, retention: `${LOG_TTL_DAYS} days (TTL)`, sync: 'CDC from Postgres log tables (event · siem · audit)', lastTs: null, bySource: [] };
    try {
      out.version = String(await this.ch(`SELECT version()`)).trim();
      const meta = await this.ch(`SELECT count() AS rows, toString(max(ts)) AS lastTs FROM ${CH_DB}.logs FORMAT JSON`, true);
      out.rows = Number(meta.data?.[0]?.rows ?? 0);
      out.lastTs = meta.data?.[0]?.lastTs && !String(meta.data[0].lastTs).startsWith('1970') ? meta.data[0].lastTs : null;
      const sz = await this.ch(`SELECT formatReadableSize(sum(bytes_on_disk)) AS size FROM system.parts WHERE database='${CH_DB}' AND table='logs' AND active FORMAT JSON`, true).catch(() => null);
      out.size = sz?.data?.[0]?.size ?? '0 B';
      const bs = await this.ch(`SELECT source, count() AS c FROM ${CH_DB}.logs GROUP BY source ORDER BY c DESC FORMAT JSON`, true).catch(() => null);
      out.bySource = (bs?.data ?? []).map((r: any) => ({ source: r.source, count: Number(r.c) }));
      out.ok = true;
    } catch (e) {
      out.error = String((e as Error)?.message ?? e).slice(0, 160);
      out.provisioning = !this.chReady;
    }
    return out;
  }

  /** Fast full-text-ish log search over ClickHouse — admin only. */
  async searchLogs(opts: { q?: string; source?: string; limit?: number }) {
    if (!this.chReady) await this.ensureClickHouse().catch(() => undefined);
    const where: string[] = [];
    if (opts.source && (LOG_SOURCES as readonly string[]).includes(opts.source)) where.push(`source='${opts.source}'`);
    if (opts.q) {
      const safe = opts.q.replace(/'/g, "''");
      where.push(`(positionCaseInsensitive(message,'${safe}')>0 OR positionCaseInsensitive(detail,'${safe}')>0 OR positionCaseInsensitive(host,'${safe}')>0 OR positionCaseInsensitive(level,'${safe}')>0)`);
    }
    const lim = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const sql = `SELECT toString(ts) AS ts, source, level, category, host, actor, message FROM ${CH_DB}.logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ${lim} FORMAT JSON`;
    const t0 = Date.now();
    try {
      const j = await this.ch(sql, true);
      return { ok: true, tookMs: Date.now() - t0, rows: j.data ?? [], scanned: Number(j.rows_before_limit_at_least ?? j.data?.length ?? 0) };
    } catch (e) {
      return { ok: false, tookMs: Date.now() - t0, rows: [], scanned: 0, error: String((e as Error)?.message ?? e).slice(0, 160) };
    }
  }

  /** Live status of the primary database: engine, size, uptime, replication, per-table stats. */
  async status() {
    const q = <T = any>(sql: string) => this.prisma.$queryRawUnsafe<T[]>(sql);
    const out: any = { engine: 'PostgreSQL', ok: true, version: '', size: '', sizeBytes: 0, uptime: '', tables: [], replication: { mode: 'standalone', replicas: 0, inRecovery: false } };
    try {
      out.version = ((await q<{ version: string }>('select version() as version'))[0]?.version ?? '').split(',')[0];
      const s = (await q<{ p: string; b: string }>('select pg_size_pretty(pg_database_size(current_database())) as p, pg_database_size(current_database())::text as b'))[0];
      out.size = s?.p ?? ''; out.sizeBytes = Number(s?.b ?? 0);
      out.uptime = (await q<{ u: string }>(`select date_trunc('second', now() - pg_postmaster_start_time())::text as u`))[0]?.u ?? '';
      const inRecovery = (await q<{ r: boolean }>('select pg_is_in_recovery() as r'))[0]?.r ?? false;
      const replicas = Number((await q<{ c: string }>('select count(*)::text as c from pg_stat_replication'))[0]?.c ?? 0);
      out.replication = { inRecovery, replicas, mode: inRecovery ? 'replica (standby)' : replicas > 0 ? 'primary' : 'standalone' };
      const t = await q<{ name: string; rows: string; bytes: string; size: string }>(
        'select relname as name, n_live_tup::text as rows, pg_total_relation_size(relid)::text as bytes, pg_size_pretty(pg_total_relation_size(relid)) as size from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 40',
      );
      out.tables = t.map((r) => ({ name: r.name, rows: Number(r.rows), bytes: Number(r.bytes), size: r.size, isLog: LOG_TABLES.has(r.name) }));
    } catch (e) {
      out.ok = false; out.error = String((e as Error)?.message ?? e).slice(0, 200);
    }
    out.backupDir = BACKUP_DIR;
    out.backupExternalPath = (await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null) as any)?.backupExternalPath ?? '';
    out.logStore = await this.logStoreStatus().catch(() => ({ engine: 'ClickHouse', ok: false, retention: `${LOG_TTL_DAYS} days (TTL)`, provisioning: true }));
    return out;
  }

  /** List the gzip backups produced by the daily backup job + any manual ones. */
  async backups() {
    try {
      const files = (await fs.promises.readdir(BACKUP_DIR)).filter((f) => f.endsWith('.sql.gz') || (f.startsWith('mcmf-full-') && f.endsWith('.tar')));
      const rows = await Promise.all(files.map(async (f) => { const st = await fs.promises.stat(path.join(BACKUP_DIR, f)); return { name: f, bytes: st.size, at: st.mtime.toISOString(), manual: f.includes('manual'), full: f.startsWith('mcmf-full-') }; }));
      return rows.sort((a, b) => b.at.localeCompare(a.at));
    } catch {
      return [];
    }
  }

  /** Run an on-demand pg_dump into the backup volume. */
  async backupNow() {
    const c = dbConn();
    if (!c) throw new BadRequestException('DATABASE_URL is not configured');
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true }).catch(() => undefined);
    const file = path.join(BACKUP_DIR, `mcmf-manual-${new Date().toISOString().replace(/[:.]/g, '-')}.sql.gz`);
    const tmp = `/tmp/mcmf-dump-${Date.now()}.sql`;
    try {
      // Dump to a temp file first (so pg_dump's exit code surfaces — a pipe would hide it), then gzip.
      await execFileP('sh', ['-c', `set -e; pg_dump -h ${c.host} -p ${c.port} -U ${c.user} -d ${c.db} -f "${tmp}" && gzip -c "${tmp}" > "${file}"`], { env: { ...process.env, PGPASSWORD: c.pass }, timeout: 180_000 });
    } catch (e) {
      await fs.promises.rm(file, { force: true }).catch(() => undefined);
      throw new BadRequestException(`backup failed: ${String((e as any)?.stderr || (e as Error)?.message || e).slice(0, 240)}`);
    } finally {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
    const st = await fs.promises.stat(file);
    const external = await this.copyToExternal(file);
    return { ok: true, name: path.basename(file), bytes: st.size, at: st.mtime.toISOString(), external };
  }

  /** Copy a finished backup to the off-server destination (NFS/network share mounted into the
   *  container), if configured — so backups don't live only on this server. Best-effort. */
  private async copyToExternal(file: string): Promise<string | null> {
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    const dest = String((org as any)?.backupExternalPath ?? '').trim();
    if (!dest) return null;
    try {
      await fs.promises.mkdir(dest, { recursive: true }).catch(() => undefined);
      const out = path.join(dest, path.basename(file));
      await fs.promises.copyFile(file, out);
      return out;
    } catch (e) {
      this.log.warn(`external backup copy to ${dest} failed: ${String((e as Error)?.message ?? e)}`);
      return null;
    }
  }

  /** Validate a backup filename (no path traversal) and return its absolute path for download. */
  backupFilePath(name: string): string {
    const base = path.basename(String(name ?? ''));
    if (!base || base !== name || !/\.(sql\.gz|tar)$/.test(base)) throw new BadRequestException('invalid backup name');
    const p = path.join(BACKUP_DIR, base);
    if (!fs.existsSync(p)) throw new NotFoundException('backup not found');
    return p;
  }

  /** Set the off-server backup destination (an NFS/network path mounted into the container). */
  async setBackupExternalPath(p: string) {
    const v = String(p ?? '').trim();
    await this.prisma.orgSettings.upsert({ where: { id: 1 }, update: { backupExternalPath: v } as any, create: { id: 1, backupExternalPath: v } as any });
    return { ok: true, backupExternalPath: v };
  }

  /**
   * Generate a complete, tailored failover/HA setup guide for a standby VM. The operator supplies
   * the standby IP; we fill in this primary's IP + DB name and a generated replication password,
   * and emit copy-paste steps for Postgres streaming replication + full app-stack failover.
   */
  failoverGuide(body: { standbyIp?: string; replPassword?: string }) {
    const standby = String(body?.standbyIp ?? '').trim();
    if (!standby || !/^[A-Za-z0-9.\-]+$/.test(standby)) throw new BadRequestException('a valid standby VM IP / hostname is required');
    const primary = (process.env.SSO_BASE_URL || 'https://localhost').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    const c = dbConn();
    const dbName = c?.db ?? 'mcmf';
    const appUser = c?.user ?? 'mcmf';
    const pw = (String(body?.replPassword ?? '').trim()) || ('repl_' + Math.random().toString(36).slice(2, 14));

    const md = `# MCMF High-Availability / Failover Setup
Primary: **${primary}**  →  Standby (failover): **${standby}**
Method: PostgreSQL 16 **streaming replication** (hot standby, ~0 data loss) + a full app stack on the standby.

> Run the **PRIMARY** blocks on this server (${primary}); run the **STANDBY** blocks on ${standby}.
> The generated replication password is below — keep it safe.
> Replication user: \`replicator\`   ·   password: \`${pw}\`

---
## 1 · PRIMARY — allow the standby to replicate   (run on ${primary})
\`\`\`bash
# 1a. Create the replication role (idempotent)
docker exec mcmf-std-db psql -U ${appUser} -d ${dbName} -v ON_ERROR_STOP=1 -c "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='replicator') THEN CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${pw}'; END IF; END \\$\\$;"

# 1b. Let the standby connect for replication, then reload
docker exec mcmf-std-db sh -c "grep -q '${standby}/32' /var/lib/postgresql/data/pg_hba.conf || echo 'host replication replicator ${standby}/32 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"
docker exec mcmf-std-db psql -U ${appUser} -d ${dbName} -c "SELECT pg_reload_conf();"

# 1c. Publish Postgres to the standby ONLY (Postgres 16 already has wal_level=replica + max_wal_senders=10)
#     In docker-compose.yml, under the 'db' service add:   ports: ["5432:5432"]   then:
docker compose up -d db
sudo ufw allow from ${standby} to any port 5432 proto tcp    # firewalld: firewall-cmd --add-rich-rule='rule family=ipv4 source address=${standby} port port=5432 protocol=tcp accept' --permanent && firewall-cmd --reload
\`\`\`

---
## 2 · STANDBY — base-backup the primary   (run on ${standby})
\`\`\`bash
# Prereqs: Docker installed; copy the MCMF app folder (~/mcmf), its .env and ~/mcmf-certs from the primary.
docker volume create mcmf-std-db    # the app's db volume name
# Seed it from the primary with a streaming-ready base backup (-R writes standby.signal + primary_conninfo):
docker run --rm -e PGPASSWORD='${pw}' -v mcmf-std-db:/var/lib/postgresql/data postgres:16 \\
  pg_basebackup -h ${primary} -p 5432 -U replicator -D /var/lib/postgresql/data -Fp -Xs -P -R
\`\`\`

---
## 3 · STANDBY — bring the platform up (hot standby)   (run on ${standby})
\`\`\`bash
cd ~/mcmf && docker compose up -d        # db starts in HOT STANDBY (read-only), streaming from the primary
\`\`\`
Verify on the **PRIMARY**:
\`\`\`bash
docker exec mcmf-std-db psql -U ${appUser} -d ${dbName} -c "SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication;"
# You should see ${standby} with state=streaming. The Database panel's Replication field will also show 1 replica.
\`\`\`

---
## 4 · FAILOVER — promote the standby   (run on ${standby} when the primary is down)
\`\`\`bash
docker exec mcmf-std-db psql -U ${appUser} -d ${dbName} -c "SELECT pg_promote();"   # standby becomes read-write
docker exec mcmf-std-nginx nginx -s reload
\`\`\`
The standby (${standby}) now serves the full platform read-write.

---
## 5 · Redirect traffic to the standby
- **DNS:** point your MCMF hostname's A-record to **${standby}** (lowest practical TTL), **or**
- **Floating/virtual IP:** run **keepalived** on both VMs sharing one VIP — it moves to the standby automatically on primary failure (no DNS wait). Put the VIP in SSO_BASE_URL / WEB_ORIGIN.
- **Agents** keep working if you use a VIP/DNS; otherwise update the MCMF IP in the tray agent / connections to ${standby}.

---
## 6 · After recovery — rebuild the old primary as the new standby
Repeat steps 1–3 with the roles reversed (old primary ${primary} becomes the standby of ${standby}). This restores protection.

---
## Notes
- **RPO ≈ 0** (synchronous streaming optional), **RTO** = the seconds it takes to promote + redirect.
- The daily \`pg_dump\` backups (Database → Backups) remain the cold fallback (restore: \`gunzip < file | docker exec -i mcmf-std-db psql -U ${appUser} -d ${dbName}\`).
- **Logs:** once the ClickHouse log database is added (next phase), it replicates separately via ClickHouse Keeper — this guide will gain a step for it.
`;
    return { primaryIp: primary, standbyIp: standby, replUser: 'replicator', replPassword: pw, markdown: md };
  }

  // ── HA cluster (1 primary + up to 4 replicas) ─────────────────────────────
  private primaryHost(): string {
    return (process.env.SSO_BASE_URL || 'https://localhost').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  }
  /** This server's environment role (development | test | production) — drives same-env vs cross-env sync. */
  private async envLabel(): Promise<string> {
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    return (org as any)?.envLabel ?? 'production';
  }
  /** TCP reachability probe (app port) — powers per-node health in the cluster panel. */
  private tcpReachable(host: string, port = 443, timeoutMs = 2500): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let done = false;
      const finish = (ok: boolean) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
      try { sock.connect(port, host); } catch { finish(false); }
    });
  }

  /** Cluster topology + live node health + per-replica streaming lag + the failover CNAME. */
  async clusterStatus() {
    const [nodes, org, repl] = await Promise.all([
      this.prisma.clusterNode.findMany({ orderBy: [{ role: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.orgSettings.findUnique({ where: { id: 1 } }),
      this.prisma.$queryRawUnsafe<any[]>(`select client_addr::text as addr, state, sync_state, coalesce(replay_lag::text,'') as lag, coalesce(pg_wal_lsn_diff(sent_lsn, replay_lsn)::text,'0') as lagbytes from pg_stat_replication`).catch(() => [] as any[]),
    ]);
    const byAddr = new Map(repl.map((r) => [r.addr, r]));
    const enriched = await Promise.all(
      nodes.map(async (n) => {
        const reachable = await this.tcpReachable(n.host).catch(() => false);
        const r = byAddr.get(n.host);
        // A "deploying" status only reflects a LIVE sync. If the runner crashed (api restart) the row
        // can be stuck on "deploying 0%" forever — treat a deploy older than 25 min as no-longer-active:
        // if it ever synced it's effectively "deployed" (replication completed), else "failed".
        const stale = n.deployStatus === 'deploying' && (!n.deployStartedAt || Date.now() - n.deployStartedAt.getTime() > 25 * 60_000);
        const deployStatus = stale ? (n.lastSyncAt ? 'deployed' : 'failed') : n.deployStatus;
        const deployProgress = deployStatus === 'deployed' ? 100 : deployStatus === 'deploying' ? ((n as any).deployProgress ?? 0) : 0;
        return {
          id: n.id, name: n.name, host: n.host, role: n.role, subnet: n.subnet, reachable,
          replState: r?.state ?? null, lag: r?.lag || null, lagBytes: r ? Number(r.lagbytes) : null,
          // Auto-deploy view (password is never sent to the client — only whether creds are saved).
          sshUser: n.sshUser ?? null, sshPort: n.sshPort ?? 22, hasCreds: !!n.sshPassSealed,
          deployStatus, deployStartedAt: n.deployStartedAt?.toISOString() ?? null, deployLog: n.deployLog || '',
          deployProgress, syncPaused: (n as any).syncPaused ?? false,
          // Sync view: a deployed clone is "in sync" as of its last clone/re-sync (full-clone model,
          // not live streaming). The Replication column uses this instead of a misleading "not streaming".
          lastSyncAt: n.lastSyncAt?.toISOString() ?? null,
          syncState: n.role === 'primary' ? 'writer' : r ? (r.sync_state ?? 'streaming') : deployStatus === 'deployed' ? 'in-sync' : 'none',
          environment: n.environment,
          // CI/CD: the build this node last received + the source server + when the code was deployed.
          lastDeployVersion: (n as any).lastDeployVersion || null,
          lastDeploySource: (n as any).lastDeploySource || null,
          lastDeployAt: (n as any).lastDeployAt?.toISOString() ?? null,
        };
      }),
    );
    // CI/CD audit trail — the recent deploys this server pushed (+ what each target received from where).
    const deploys = await this.prisma.deployRecord
      .findMany({ orderBy: { createdAt: 'desc' }, take: 5 })
      .then((rows) => rows.map((d) => ({ version: d.version, kind: d.kind, sourceHost: d.sourceHost, targetHost: d.targetHost, targetName: d.targetName, status: d.status, changes: (d as any).changes || '', files: (Array.isArray((d as any).files) ? (d as any).files : []) as { p: string; c: string }[], at: d.createdAt.toISOString() })))
      .catch(() => [] as any[]);
    const envLabel = (org as any)?.envLabel ?? 'production';
    // This server orchestrates (deploy/setup/promote/sync) only when it is the Development control plane.
    // A production/test server is a passive target: it can't reach Dev, so it only shows last-sync + stop-sync.
    return { cname: org?.clusterCname ?? '', primaryHost: this.primaryHost(), envLabel, canOrchestrate: envLabel === 'development', maxNodes: 5, replicasConnected: repl.length, nodes: enriched, build: `1.0.0+build.${(org as any)?.buildNumber ?? 0}`, deploys };
  }

  async addClusterNode(body: any) {
    if ((await this.prisma.clusterNode.count()) >= 5) throw new BadRequestException('Cluster is limited to 5 nodes (1 primary + 4 replicas).');
    const host = String(body?.host ?? '').trim();
    if (!host || !/^[A-Za-z0-9.\-]+$/.test(host)) throw new BadRequestException('A valid node IP or hostname is required.');
    const name = String(body?.name ?? '').trim() || host;
    const role = body?.role === 'primary' ? 'primary' : 'replica';
    const subnet = String(body?.subnet ?? '').trim() || null;
    // Optional SSH credentials captured at add-time so the node can be auto-deployed with one click.
    const sshUser = String(body?.sshUser ?? '').trim() || null;
    const sshPort = Number(body?.sshPort) > 0 ? Number(body.sshPort) : 22;
    const pass = String(body?.sshPassword ?? '');
    const sshPassSealed = pass ? encryptJson({ pass }) : null;
    if (role === 'primary') await this.prisma.clusterNode.updateMany({ where: { role: 'primary' }, data: { role: 'replica' } });
    return this.prisma.clusterNode.create({ data: { name, host, role, subnet, sshUser, sshPort, sshPassSealed } }).catch((e: any) => {
      if (String(e?.code) === 'P2002') throw new BadRequestException('That node host is already registered.');
      throw e;
    });
  }

  /** Update a node's SSH credentials (used to add/replace creds on an existing node). */
  async setClusterNodeCreds(id: string, body: any) {
    const node = await this.prisma.clusterNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    const data: any = {};
    if (body?.sshUser !== undefined) data.sshUser = String(body.sshUser ?? '').trim() || null;
    if (body?.sshPort !== undefined) data.sshPort = Number(body.sshPort) > 0 ? Number(body.sshPort) : 22;
    if (body?.sshPassword) data.sshPassSealed = encryptJson({ pass: String(body.sshPassword) });
    await this.prisma.clusterNode.update({ where: { id }, data });
    return { ok: true };
  }

  async removeClusterNode(id: string) {
    await this.prisma.clusterNode.delete({ where: { id } }).catch(() => { throw new NotFoundException('node not found'); });
    return { ok: true };
  }

  async setClusterCname(cname: string) {
    const v = String(cname ?? '').trim();
    if (v && !/^[A-Za-z0-9.\-]+$/.test(v)) throw new BadRequestException('Enter a valid hostname / VIP (letters, digits, dots, hyphens).');
    await this.prisma.orgSettings.upsert({ where: { id: 1 }, update: { clusterCname: v }, create: { id: 1, clusterCname: v } });
    return { ok: true, cname: v };
  }

  /** Per-node setup runbook: configure this node as a streaming hot-standby of the primary. */
  async clusterNodeGuide(id: string) {
    const node = await this.prisma.clusterNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    const guide = await this.failoverGuide({ standbyIp: node.host });
    const cname = (await this.prisma.orgSettings.findUnique({ where: { id: 1 } }))?.clusterCname ?? '';
    const header =
      `# Cluster node setup — ${node.name} (${node.host})\n` +
      `Role: **${node.role}** · part of your MCMF HA cluster (1 primary + up to 4 replicas).` +
      (cname ? `\nCluster CNAME / VIP: **${cname}** — point agents & clients here; on failover it moves to the active node (works across subnets).` : `\n> Tip: set a Cluster CNAME / VIP in the panel so agents fail over automatically with no reconfig.`) +
      `\n\nThis configures **${node.host}** as a streaming hot-standby of the primary **${guide.primaryIp}** (independent app stack; only the DB syncs).\n\n---\n`;
    return { ...guide, role: node.role, cname, markdown: header + guide.markdown };
  }

  /** Failover runbook: promote a replica to primary and repoint the rest of the cluster. */
  async clusterPromoteGuide(id: string) {
    const node = await this.prisma.clusterNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    const c = dbConn();
    const dbName = c?.db ?? 'mcmf';
    const appUser = c?.user ?? 'mcmf';
    const cname = (await this.prisma.orgSettings.findUnique({ where: { id: 1 } }))?.clusterCname ?? '';
    const others = (await this.prisma.clusterNode.findMany({ where: { id: { not: id } } })).map((n) => n.host);
    const repoint = others.length
      ? others.map((h) => `# on ${h}:\ndocker exec mcmf-std-db psql -U ${appUser} -d ${dbName} -c "ALTER SYSTEM SET primary_conninfo = 'host=${node.host} port=5432 user=replicator';"\ndocker exec mcmf-std-db psql -U ${appUser} -d ${dbName} -c "SELECT pg_reload_conf();"`).join('\n\n')
      : '# (no other nodes registered)';
    const md =
      `# Failover — promote ${node.name} (${node.host}) to PRIMARY\n` +
      `Run when the current primary is down. ${node.host} becomes read-write and serves the full platform; the other nodes keep running.\n\n` +
      `## 1 · Promote the standby   (run on ${node.host})\n\`\`\`bash\n` +
      `docker exec mcmf-std-db psql -U ${appUser} -d ${dbName} -c "SELECT pg_promote();"   # standby → read-write\n` +
      `docker exec mcmf-std-nginx nginx -s reload\n\`\`\`\n\n` +
      `## 2 · Move clients to the new primary\n` +
      (cname ? `- **CNAME / VIP:** repoint **${cname}** to **${node.host}** (lowest practical TTL). Agents and the UI follow automatically — including across subnets — with no per-agent change.\n` : `- Set a Cluster CNAME / VIP in the panel for automatic client failover; otherwise update the MCMF IP in the tray agent / connections to ${node.host}.\n`) +
      `\n## 3 · Re-point the surviving replicas to the new primary\n\`\`\`bash\n${repoint}\n\`\`\`\n\n` +
      `## 4 · After the old primary recovers\n` +
      `Rebuild it as a standby of ${node.host} using that node's **Setup guide** — this restores full protection.\n\n` +
      `> RPO ≈ 0 (streaming) · RTO = the seconds to promote + repoint the CNAME.`;
    return { node: node.host, cname, markdown: md };
  }

  // ── Automated replica deployment (one-click full clone over SSH) ──────────
  /** Append a timestamped line to a node's live deploy log (bounded). */
  private async appendDeployLog(id: string, line: string, progress?: number) {
    const n = await this.prisma.clusterNode.findUnique({ where: { id } }).catch(() => null);
    const log = ((n?.deployLog || '') + `[${new Date().toISOString().slice(11, 19)}] ${line}\n`).slice(-8000);
    const data: any = { deployLog: log };
    if (progress !== undefined) data.deployProgress = Math.max(0, Math.min(100, Math.round(progress)));
    await this.prisma.clusterNode.update({ where: { id }, data }).catch(() => undefined);
  }

  /** Tar this platform's own running source (mounted read-only) for transfer to a replica. */
  private async packageSource(): Promise<string> {
    const SRC = '/opt/mcmf-src';
    if (!fs.existsSync(path.join(SRC, 'docker-compose.yml'))) {
      throw new Error('source mount /opt/mcmf-src is missing — recreate the primary with the latest docker-compose.yml (it adds a read-only source mount), then retry the deploy.');
    }
    const out = `/tmp/mcmf-src-${Date.now()}.tgz`;
    await execFileP('sh', ['-c', `cd ${SRC} && tar czf ${out} --exclude=node_modules --exclude=.git --exclude=dist --exclude=.next --exclude=coverage --exclude='*.tgz' --exclude='*.tar.gz' .`], { timeout: 120_000 });
    return out;
  }

  /** Per-file content manifest of the mounted source ({path: shortHash}) + an aggregate hash. The
   *  manifest is diffed against the last deploy to produce the changelog; the aggregate hash lets a
   *  sync skip the rebuild when no code changed. */
  private async sourceFingerprint(): Promise<{ manifest: Record<string, string>; hash: string }> {
    const SRC = '/opt/mcmf-src';
    try {
      const out = await execFileP('sh', ['-c', `cd ${SRC} && find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -not -path './.next/*' -not -name '*.tgz' -not -name '*.tar.gz' | sort | xargs sha256sum 2>/dev/null`], { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
      const manifest: Record<string, string> = {};
      for (const line of out.stdout.split('\n')) { const sp = line.trim().split(/\s+/); if (sp.length === 2) manifest[sp[1].replace(/^\.\//, '')] = sp[0].slice(0, 12); }
      const hash = createHash('sha256').update(JSON.stringify(Object.entries(manifest).sort())).digest('hex');
      return { manifest, hash };
    } catch {
      return { manifest: {}, hash: '' };
    }
  }

  /** Map a changed source path to a human "feature area" so each build's changelog reads as what was
   *  touched (Security, AI Engine, Cloud Connectors…) rather than a raw list of file paths. */
  private areaForPath(p: string): string {
    const s = p.toLowerCase();
    if (/prisma\/schema\.prisma/.test(s)) return 'Database schema';
    if (/osinventory/.test(s)) return 'OS Inventory';
    if (/agent-assets|modules\/agent|modules\/command-center/.test(s)) return 'Guest Agent';
    if (/connectors\//.test(s)) return 'Cloud Connectors';
    if (/modules\/ai|features\/ai/.test(s)) return 'AI Engine';
    if (/security/.test(s)) return 'Security & Alerting';
    if (/governance/.test(s)) return 'Governance';
    if (/finops/.test(s)) return 'FinOps & Carbon';
    if (/network|topology|monitor/.test(s)) return 'Network & Monitoring';
    if (/catalog/.test(s)) return 'Service Catalog';
    if (/settings|integrations/.test(s)) return 'Settings & Integrations';
    if (/\bauth\b/.test(s)) return 'Auth & Access';
    if (/database\.service|modules\/database/.test(s)) return 'Cluster / CI-CD';
    if (/components\/|app\/|globals\.css|lib\//.test(s)) return 'Web UI / shell';
    if (/api\/src/.test(s)) return 'API / backend';
    return 'Other';
  }

  /** Diff a new file manifest vs the previous deploy → { summary, files }. summary = feature areas +
   *  change counts (human); files = per-file change list (kept so the UI can also show what changed). */
  private changelogFor(prev: Record<string, string>, next: Record<string, string>): { summary: string; files: { p: string; c: '+' | '~' | '-' }[] } {
    if (!prev || Object.keys(prev).length === 0) return { summary: 'Initial baseline', files: [] };
    const files: { p: string; c: '+' | '~' | '-' }[] = [];
    for (const [f, h] of Object.entries(next)) if (prev[f] !== h) files.push({ p: f, c: prev[f] ? '~' : '+' });
    for (const f of Object.keys(prev)) if (!(f in next)) files.push({ p: f, c: '-' });
    if (!files.length) return { summary: 'No code change (config / data only)', files: [] };
    const added = files.filter((x) => x.c === '+').length;
    const modified = files.filter((x) => x.c === '~').length;
    const removed = files.filter((x) => x.c === '-').length;
    const areaCount = new Map<string, number>();
    for (const x of files) { const a = this.areaForPath(x.p); areaCount.set(a, (areaCount.get(a) ?? 0) + 1); }
    const areas = [...areaCount.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
    const counts = `${files.length} file${files.length === 1 ? '' : 's'} (${[added && `+${added}`, modified && `~${modified}`, removed && `-${removed}`].filter(Boolean).join(' ')})`;
    return { summary: `${areas.slice(0, 6).join(', ')}${areas.length > 6 ? ` +${areas.length - 6} more` : ''} · ${counts}`, files: files.slice(0, 200) };
  }

  /** Build the replica's .env from this primary's live config so the clone is an exact match. */
  private buildEnvFile(targetHost?: string): string {
    // Secrets/integrations carry over from the primary; host-identity is set to the TARGET so the
    // replica shows ITSELF as its host (not the primary's IP) — SSO_BASE_URL/WEB_ORIGIN are excluded here.
    const keys = [
      'APP_ENCRYPTION_KEY', 'AGENT_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
      'SSO_AUTO_PROVISION', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET',
      'MS_TENANT', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'PROVISION_EXEC', 'ANTHROPIC_API_KEY', 'AI_MODEL', 'AI_PROVIDER',
      'CLICKHOUSE_URL', 'LOG_TTL_DAYS', 'NEXT_PUBLIC_API_URL',
    ];
    const lines = [
      '# Auto-generated by MCMF HA auto-deploy.',
      'DEMO_SEED=0', // data is restored from the primary snapshot; never re-seed demo data
      `ALLOW_ALL_ORIGINS=${process.env.ALLOW_ALL_ORIGINS || '1'}`, // serve the UI from the replica's own host
    ];
    if (targetHost) {
      lines.push(`SSO_BASE_URL=https://${targetHost}`);
      lines.push(`WEB_ORIGIN=https://${targetHost},https://localhost`);
    }
    for (const k of keys) {
      const v = process.env[k];
      if (v !== undefined && v !== '') lines.push(`${k}=${v}`);
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Deploy (or re-deploy) a registered replica node as a full, independent clone of this platform
   * over SSH: install Docker → clone the repo → overlay the primary's secrets (.env) + DB snapshot →
   * build & start the full stack. Credentials are sealed for one-click re-deploys. Runs async; the
   * panel polls cluster status for live progress.
   */
  async deployReplica(id: string, body: any) {
    const node = await this.prisma.clusterNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    if (node.role === 'primary') throw new BadRequestException('Refusing to deploy onto the primary node.');
    if ((node as any).syncPaused) throw new BadRequestException('Sync is stopped for this node. Resume it before deploying.');
    // SAFETY: a full deploy wipes the target's data (down -v + DB restore). FIRST-TIME stand-up of a
    // new node is allowed (that's the only full sync a fresh node needs). A RE-deploy of an already-
    // deployed node is only allowed within the same environment (prod→prod / dev→dev HA); across
    // environments (dev→prod) it would destroy real data — use "Sync to Production" instead.
    if (node.deployStatus === 'deployed') {
      const sourceEnv = await this.envLabel();
      if (sourceEnv !== node.environment) {
        throw new BadRequestException(`Re-deploy (full clone) only runs within the same environment — this is a ${sourceEnv} server and the node is ${node.environment}. Use “Sync to Production” (code + config, preserves data). First-time stand-up of a new node is allowed.`);
      }
    }
    if (node.deployStatus === 'deploying') {
      // Don't permanently lock a node if the api restarted mid-deploy — treat a stale run as abandoned.
      const ageMs = node.deployStartedAt ? Date.now() - node.deployStartedAt.getTime() : Infinity;
      if (ageMs < 25 * 60_000) throw new BadRequestException('A deployment is already in progress for this node.');
    }
    const user = String(body?.sshUser ?? node.sshUser ?? '').trim();
    const port = Number(body?.sshPort) > 0 ? Number(body.sshPort) : node.sshPort || 22;
    let pass = String(body?.sshPassword ?? '');
    if (!pass && node.sshPassSealed) { try { pass = decryptJson<{ pass: string }>(node.sshPassSealed).pass; } catch { /* re-prompt below */ } }
    if (!user || !pass) throw new BadRequestException('SSH username and password are required to deploy this replica.');
    // Persist the (sealed) creds so future deploys are one-click.
    await this.prisma.clusterNode.update({
      where: { id },
      data: { sshUser: user, sshPort: port, sshPassSealed: encryptJson({ pass }), deployStatus: 'deploying', deployStartedAt: new Date(), deployLog: '', deployProgress: 0 } as any,
    });
    void this.runDeploy(id, node.host, user, port, pass);
    return { ok: true, status: 'deploying', host: node.host };
  }

  /** The actual SSH orchestration (fire-and-forget; status + log tracked in the DB). */
  private async runDeploy(id: string, host: string, user: string, port: number, pass: string) {
    const home = `/home/${user}`;
    const sudoSh = (cmd: string) => `echo ${shq(pass)} | sudo -S -p '' sh -c ${shq(cmd)}`;
    try {
      await this.appendDeployLog(id, `Connecting to ${user}@${host}:${port} …`, 3);
      // 1 · Docker engine present? install via the official script if not.
      let r = await sshRun(host, port, user, pass, `command -v docker >/dev/null 2>&1 && echo HAVE || echo NO`, 30_000);
      if (!r.stdout.includes('HAVE')) {
        await this.appendDeployLog(id, 'Installing Docker engine …');
        await sshRun(host, port, user, pass, `curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && ${sudoSh('sh /tmp/get-docker.sh')}`, 360_000);
      }
      // 2 · ensure the deploy user can run docker without sudo (so the stdin-piped restore works).
      await sshRun(host, port, user, pass, sudoSh(`usermod -aG docker ${user}; systemctl enable --now docker 2>/dev/null || true`), 60_000);
      r = await sshRun(host, port, user, pass, `docker ps >/dev/null 2>&1 && echo OK || echo NOPE`, 30_000);
      if (!r.stdout.includes('OK')) throw new Error(`${user} cannot run Docker even after group add — add ${user} to the docker group on ${host} and re-deploy.`);
      // 3 · STAGE everything before touching the running replica (so a failure here is harmless):
      //     ship THIS platform's exact running source (no GitHub access/token needed) + DB snapshot.
      await this.appendDeployLog(id, "Packaging this platform's source …", 10);
      const srcTar = await this.packageSource();
      const srcKb = Math.round((await fs.promises.stat(srcTar)).size / 1024);
      await this.appendDeployLog(id, `Transferring source (${srcKb} KB) …`, 16);
      await sshPutFile(host, port, user, pass, srcTar, `${home}/mcmf-src.tgz`);
      await fs.promises.rm(srcTar, { force: true }).catch(() => undefined);
      await this.appendDeployLog(id, 'Snapshotting the primary database …', 22);
      const snap = await this.backupNow();
      await this.appendDeployLog(id, `Transferring DB snapshot (${Math.round(snap.bytes / 1024)} KB) …`, 28);
      await sshPutFile(host, port, user, pass, path.join(BACKUP_DIR, snap.name), `${home}/mcmf-db.sql.gz`);
      // 4 · SWAP IN the new stack (first destructive step — old volumes wiped for a clean restore).
      await this.appendDeployLog(id, 'Staging new deploy & writing secrets …', 35);
      await sshRun(host, port, user, pass, `cd ~/mcmf 2>/dev/null && docker compose down -v 2>/dev/null; cd ~ && rm -rf mcmf && mkdir -p mcmf && tar xzf ~/mcmf-src.tgz -C ~/mcmf && rm -f ~/mcmf-src.tgz`, 180_000);
      // point the nginx cert mount at THIS user's home (the repo hardcodes the primary's path).
      await sshRun(host, port, user, pass, `cd ~/mcmf && sed -i ${shq(`s#/home/mcmf/mcmf-certs#${home}/mcmf-certs#g`)} docker-compose.yml`, 30_000);
      // overlay the primary's secrets (.env) so the vault key + integrations match exactly.
      await sshWriteFile(host, port, user, pass, `${home}/mcmf/.env`, this.buildEnvFile(host));
      // TLS certificate for the replica host (self-signed; reuse if already present). A subjectAltName
      // (SAN) is required by modern browsers — without it the cert can't be trusted even when imported.
      const san = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `IP:${host}` : `DNS:${host}`;
      await sshRun(host, port, user, pass, `mkdir -p ~/mcmf-certs && [ -f ~/mcmf-certs/fullchain.pem ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout ~/mcmf-certs/privkey.pem -out ~/mcmf-certs/fullchain.pem -days 3650 -subj ${shq(`/CN=${host}/O=MCMF`)} -addext ${shq(`subjectAltName=${san},DNS:localhost`)} 2>/dev/null`, 60_000);
      // 5 · bring up a fresh DB and restore the snapshot (the api seed then skips — users exist).
      await this.appendDeployLog(id, 'Starting database & restoring snapshot …', 45);
      await sshRun(host, port, user, pass, `cd ~/mcmf && DOCKER_BUILDKIT=0 docker compose up -d db`, 240_000);
      await sshRun(host, port, user, pass, `for i in $(seq 1 40); do docker exec mcmf-std-db pg_isready -U mcmf -d mcmf 2>/dev/null | grep -q accepting && break; sleep 3; done; gunzip < ~/mcmf-db.sql.gz | docker exec -i mcmf-std-db psql -U mcmf -d mcmf -q && rm -f ~/mcmf-db.sql.gz`, 300_000);
      // 8 · build & start the full stack. The build is launched DETACHED (nohup) and writes its own
      //     log on the target; we then poll that log from fresh connections. The launch exec often
      //     does not return cleanly (the backgrounded build holds the SSH channel open), so we cap it
      //     short and SWALLOW a timeout — the nohup build runs regardless, and the poll is the source
      //     of truth. (A synchronous hold of the channel through the whole build proved unreliable.)
      await this.appendDeployLog(id, 'Building & starting the full stack — this takes several minutes …', 55);
      await sshRun(host, port, user, pass, `cd ~/mcmf && rm -f /tmp/mcmf-deploy.log; nohup sh -c 'DOCKER_BUILDKIT=0 docker compose up --build -d > /tmp/mcmf-deploy.log 2>&1; echo MCMF_BUILD_DONE=$? >> /tmp/mcmf-deploy.log' >/dev/null 2>&1 </dev/null & echo started`, 20_000).catch(() => undefined);
      const deadline = Date.now() + 18 * 60_000;
      let finished = false;
      let buildCode = 0;
      let lastUp = -1;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 15_000));
        const p = await sshRun(host, port, user, pass, `sed -n 's/^MCMF_BUILD_DONE=//p' /tmp/mcmf-deploy.log 2>/dev/null | tail -1; echo '|'; docker ps --format '{{.Names}}' 2>/dev/null | grep -c mcmf-std`, 40_000).catch(() => null);
        if (!p) continue;
        const [doneStr, upStr] = p.stdout.split('|');
        const up = Number((upStr || '').trim()) || 0;
        // Build phase spans 55→95%, scaled by how many of the 7 containers are up.
        if (up !== lastUp) { lastUp = up; await this.appendDeployLog(id, `… ${up}/7 containers up`, 55 + Math.min(40, (up / 7) * 40)); }
        if ((doneStr || '').trim() !== '') { finished = true; buildCode = Number(doneStr.trim()) || 0; break; }
      }
      // 9 · verify and finalize.
      const v = await sshRun(host, port, user, pass, `docker ps --format '{{.Names}}' | grep -c mcmf-std; echo '|'; docker exec mcmf-std-nginx nginx -s reload 2>/dev/null; curl -sk -o /dev/null -w '%{http_code}' https://localhost/ 2>/dev/null`, 60_000).catch(() => ({ stdout: '0|', code: 1, stderr: '' }));
      const [cntStr, httpStr] = v.stdout.split('|');
      const cnt = Number((cntStr || '').trim()) || 0;
      const httpCode = (httpStr || '').trim();
      if (cnt >= 6 && buildCode === 0) {
        await this.appendDeployLog(id, `✅ Replica deployed — ${cnt}/7 containers up${/^(2|3)\d\d$/.test(httpCode) ? `, HTTPS responding (${httpCode})` : ''}.`, 100);
        await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'deployed', lastSyncAt: new Date() } });
      } else {
        const tail = await sshRun(host, port, user, pass, `tail -8 /tmp/mcmf-deploy.log 2>/dev/null`, 30_000).catch(() => ({ stdout: '', code: 1, stderr: '' }));
        await this.appendDeployLog(id, `❌ Deploy incomplete — ${cnt}/7 up${finished ? '' : ' (build timed out)'}.\n${tail.stdout.slice(-600)}`);
        await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'failed' } });
      }
    } catch (e: any) {
      await this.appendDeployLog(id, `❌ ${String(e?.message ?? e).slice(0, 300)}`);
      await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'failed' } }).catch(() => undefined);
    }
  }

  /** Decrypt a node's saved SSH password, or throw a clear error. */
  private nodePass(node: { sshUser: string | null; sshPassSealed: string | null }): string {
    if (!node.sshUser || !node.sshPassSealed) throw new BadRequestException('SSH credentials are required for this action — add them on the node first.');
    try { return decryptJson<{ pass: string }>(node.sshPassSealed).pass; } catch { throw new BadRequestException('Saved SSH credentials are unreadable — re-enter them on the node.'); }
  }

  /**
   * Re-sync a deployed replica's DATA from the primary (full-clone model has no live streaming).
   * Fast, data-only: snapshot the primary → restore into the replica's DB → restart the app. No image
   * rebuild. Reuses the deployStatus/deployLog channel for live progress; stamps lastSyncAt on success.
   */
  async resyncReplica(id: string) {
    const node = await this.prisma.clusterNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    if (node.role === 'primary') throw new BadRequestException('The primary is the source of truth — there is nothing to re-sync onto it.');
    // SAFETY: Re-sync is a FULL DATA CLONE — it overwrites the target's database. It only makes sense
    // WITHIN one environment (HA replicas that must mirror their primary): prod→prod, dev→dev. Across
    // environments (e.g. dev→prod) it would wipe the target's real users/integrations/VMs/logs — there
    // the only path is the selective "Sync to Production" (code + config, data preserved).
    const sourceEnv = await this.envLabel();
    if (sourceEnv !== node.environment) {
      throw new BadRequestException(`Re-sync (full data clone) only runs within the same environment — this is a ${sourceEnv} server and the node is ${node.environment}. Use “Sync to Production” (code + config; preserves users, 2FA, integrations, VMs and history).`);
    }
    if (node.deployStatus === 'deploying') throw new BadRequestException('An operation is already in progress for this node.');
    if (node.deployStatus !== 'deployed') throw new BadRequestException('Deploy this replica first, then re-sync its data.');
    const pass = this.nodePass(node);
    await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'deploying', deployStartedAt: new Date(), deployLog: '' } });
    void this.runResync(id, node.host, node.sshUser!, node.sshPort || 22, pass);
    return { ok: true, status: 'deploying', host: node.host };
  }

  private async runResync(id: string, host: string, user: string, port: number, pass: string) {
    const home = `/home/${user}`;
    try {
      await this.appendDeployLog(id, `Re-syncing data from the primary → ${host} …`);
      const snap = await this.backupNow();
      await this.appendDeployLog(id, `Transferring fresh DB snapshot (${Math.round(snap.bytes / 1024)} KB) …`);
      await sshPutFile(host, port, user, pass, path.join(BACKUP_DIR, snap.name), `${home}/mcmf-db.sql.gz`);
      await this.appendDeployLog(id, 'Applying snapshot (data only — no rebuild) …');
      // Stop writers, drop the schema, restore the fresh dump, then bring the app back.
      await sshRun(host, port, user, pass, `cd ~/mcmf && docker compose stop api web 2>/dev/null; docker exec mcmf-std-db psql -U mcmf -d mcmf -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='mcmf' AND pid<>pg_backend_pid();" >/dev/null 2>&1; docker exec mcmf-std-db psql -U mcmf -d mcmf -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1; gunzip < ~/mcmf-db.sql.gz | docker exec -i mcmf-std-db psql -U mcmf -d mcmf -q && rm -f ~/mcmf-db.sql.gz`, 300_000);
      await sshRun(host, port, user, pass, `cd ~/mcmf && docker compose up -d 2>&1 | tail -2`, 240_000);
      const v = await sshRun(host, port, user, pass, `docker ps --format '{{.Names}}' | grep -c mcmf-std; echo '|'; curl -sk -o /dev/null -w '%{http_code}' https://localhost/ 2>/dev/null`, 60_000).catch(() => ({ stdout: '0|', code: 1, stderr: '' }));
      const cnt = Number((v.stdout.split('|')[0] || '').trim()) || 0;
      if (cnt >= 6) {
        await this.appendDeployLog(id, '✅ Re-synced — data refreshed from the primary.');
        await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'deployed', lastSyncAt: new Date() } });
      } else {
        await this.appendDeployLog(id, `❌ Re-sync incomplete — only ${cnt}/7 containers up.`);
        await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'failed' } });
      }
    } catch (e: any) {
      await this.appendDeployLog(id, `❌ ${String(e?.message ?? e).slice(0, 300)}`);
      await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'failed' } }).catch(() => undefined);
    }
  }

  /**
   * Execute a failover: promote a replica to primary over SSH (its DB becomes read-write, nginx
   * reloads), swap roles in the cluster registry, and repoint clients/agents via the CNAME/VIP.
   */
  async promoteReplica(id: string) {
    const node = await this.prisma.clusterNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    if (node.role === 'primary') throw new BadRequestException('That node is already the primary.');
    const pass = this.nodePass(node);
    const port = node.sshPort || 22;
    // 1 · verify the replica is fully up, then promote its DB to read-write + reload nginx.
    const chk = await sshRun(
      node.host, port, node.sshUser!, pass,
      `docker ps --format '{{.Names}}' | grep -c mcmf-std; echo '|'; docker exec mcmf-std-db psql -U mcmf -d mcmf -tAc "SELECT pg_promote();" 2>/dev/null; docker exec mcmf-std-nginx nginx -s reload 2>/dev/null; curl -sk -o /dev/null -w '%{http_code}' https://localhost/ 2>/dev/null`,
      90_000,
    ).catch((e) => { throw new BadRequestException('Cannot reach the replica over SSH to promote it: ' + String((e as Error)?.message ?? e).slice(0, 160)); });
    const cnt = Number((chk.stdout.split('|')[0] || '').trim()) || 0;
    if (cnt < 6) throw new BadRequestException(`The replica stack is not fully up (${cnt}/7) — deploy or re-sync it before promoting.`);
    // 2 · swap roles in the cluster registry.
    await this.prisma.clusterNode.updateMany({ where: { role: 'primary' }, data: { role: 'replica' } });
    await this.prisma.clusterNode.update({ where: { id }, data: { role: 'primary' } });
    // 3 · repoint clients/agents.
    const cname = (await this.prisma.orgSettings.findUnique({ where: { id: 1 } }))?.clusterCname ?? '';
    return {
      ok: true,
      promoted: node.host,
      cname,
      agentsFollow: !!cname,
      message: cname
        ? `Promoted ${node.name} (${node.host}) to PRIMARY. Point the cluster CNAME/VIP “${cname}” at ${node.host} (lowest practical TTL) — agents & clients reconnect to it automatically, across subnets.`
        : `Promoted ${node.name} (${node.host}) to PRIMARY. Set a Cluster CNAME/VIP (or update agents’ MCMF host to ${node.host}) so agents reconnect to the new primary.`,
    };
  }

  // ── Dev → Prod promotion (approval-gated full sync) ───────────────────────
  /** Set this server's environment role (development | test | production) — drives the dev→prod workflow. */
  async setEnvLabel(label: string) {
    const v = ENV_ROLES.includes(label) ? label : 'production';
    await this.prisma.orgSettings.upsert({ where: { id: 1 }, update: { envLabel: v } as any, create: { id: 1, envLabel: v } as any });
    return { ok: true, envLabel: v };
  }

  /** Tag a cluster node as development | test | production. */
  async setNodeEnvironment(id: string, env: string) {
    const v = ENV_ROLES.includes(env) ? env : 'production';
    await this.prisma.clusterNode.update({ where: { id }, data: { environment: v } }).catch(() => { throw new NotFoundException('node not found'); });
    return { ok: true, environment: v };
  }

  /** Operator "stop sync" toggle — blocks deploy/sync to this node until re-enabled. */
  async setNodeSyncPaused(id: string, paused: boolean) {
    await this.prisma.clusterNode.update({ where: { id }, data: { syncPaused: !!paused } as any }).catch(() => { throw new NotFoundException('node not found'); });
    return { ok: true, syncPaused: !!paused };
  }

  /**
   * Request a Dev → Prod sync. This does NOT sync immediately: it raises an approval request
   * (admins notified). On approval, the gate's executor runs the full deploy (everything: code +
   * data + config) so production becomes an exact mirror of development. Admins with an
   * auto-approve policy sync immediately.
   */
  async syncToProduction(id: string, actor: GateActor) {
    const node = await this.prisma.clusterNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    if (node.environment === 'development') throw new BadRequestException('Tag this node as a Test or Production environment before syncing to it.');
    if ((node as any).syncPaused) throw new BadRequestException('Sync is stopped for this node. Resume it before syncing.');
    if (!node.sshUser || !node.sshPassSealed) throw new BadRequestException('Add SSH credentials on the target node first.');
    const gate = await this.approvalGate.check({
      action: 'sync_to_prod',
      actor,
      payload: { nodeId: id },
      title: `Sync Development → Production (${node.name} / ${node.host})`,
      resourceRef: id,
      resourceName: `${node.name} (${node.host})`,
    });
    if (gate.gated) return { gated: true, requestId: gate.requestId, message: 'Approval requested — production will sync automatically once an admin approves.' };
    // Not gated (admin auto-approve) → run the selective sync now.
    void this.configSyncToProduction(id);
    return { gated: false, status: 'syncing', message: 'Approved automatically — promoting config to production now (prod data preserved).' };
  }

  /** Executor invoked by the approvals service when a sync_to_prod request is approved. */
  async runApprovedSync(nodeId: string): Promise<string> {
    const node = await this.prisma.clusterNode.findUnique({ where: { id: nodeId } });
    if (!node) throw new NotFoundException('production node no longer registered');
    void this.configSyncToProduction(nodeId);
    return `Config promotion to Production started for ${node.name} (${node.host}) — deploys dev's code + config; prod's users/2FA, cloud connections, discovered VMs and history are preserved. Track it in Settings → Database → HA Cluster.`;
  }

  /**
   * Selective dev → prod promotion: deploy dev's CODE (no data wipe) and replace only the config
   * tables (alert rules, automations, policies, dashboards, etc.), preserving prod's identity/2FA,
   * cloud connections, discovered resources, credentials, integrations and operational history.
   * Async; status + live log tracked on the node (reuses the deploy channel).
   */
  async configSyncToProduction(id: string) {
    const node = await this.prisma.clusterNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    if ((node as any).syncPaused) throw new BadRequestException('Sync is stopped for this node.');
    if (node.deployStatus === 'deployed' || node.deployStatus === 'failed' || node.deployStatus === 'none') {
      await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'deploying', deployStartedAt: new Date(), deployLog: '', deployProgress: 0 } as any });
    }
    const pass = this.nodePass(node);
    void this.runConfigSync(id, node.host, node.sshUser!, node.sshPort || 22, pass);
    return { ok: true, status: 'deploying' };
  }

  /** Build a single SQL bundle that replaces ONLY the config tables + promotes branding, run inside
   *  one transaction with FK triggers off so load order/refs never matter. */
  private async buildConfigBundle(): Promise<string> {
    const c = dbConn();
    if (!c) throw new BadRequestException('DATABASE_URL not configured');
    const env = { ...process.env, PGPASSWORD: c.pass };
    const tArgs = CONFIG_REPLACE_TABLES.map((t) => `-t '"${t}"'`).join(' ');
    const dump = await execFileP('sh', ['-c', `pg_dump --data-only -h ${c.host} -p ${c.port} -U ${c.user} ${tArgs} ${c.db}`], { env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    // Group structure: add/update dev's groups, keep prod's memberships (don't truncate — FK from GroupMembership).
    const grp = await execFileP('sh', ['-c', `pg_dump --data-only --inserts --on-conflict-do-nothing -h ${c.host} -p ${c.port} -U ${c.user} -t '"Group"' ${c.db}`], { env, timeout: 60_000 }).catch(() => ({ stdout: '' }));
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } });
    const esc = (v: any) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : typeof v === 'boolean' ? (v ? 'true' : 'false') : v == null ? 'NULL' : String(v));
    const orgSets = org
      ? [...ORG_SYNC_COLS.filter((k) => (org as any)[k] !== undefined).map((k) => `"${k}"=${esc((org as any)[k])}`),
         ...ORG_SYNC_JSON_COLS.filter((k) => (org as any)[k] !== undefined).map((k) => `"${k}"='${JSON.stringify((org as any)[k]).replace(/'/g, "''")}'::jsonb`)]
      : [];
    // pg_dump output sets search_path='' mid-bundle, so any later hand-written statement MUST be
    // schema-qualified and reset search_path — else an unqualified UPDATE errors and rolls everything back.
    const orgUpdate = orgSets.length ? `SET search_path = public;\nUPDATE public."OrgSettings" SET ${orgSets.join(', ')} WHERE id=1;` : '';
    return [
      'BEGIN;',
      'SET session_replication_role = replica;',
      'SET search_path = public;',
      `TRUNCATE ${CONFIG_REPLACE_TABLES.map((t) => `public."${t}"`).join(', ')};`,
      dump.stdout,
      grp.stdout,
      orgUpdate,
      'SET session_replication_role = default;',
      'COMMIT;',
      '',
    ].join('\n');
  }

  /** CI/CD: bump the monotonic build counter and return a semantic build version (1.0.0+build.N). */
  private async nextBuildVersion(): Promise<string> {
    const org = await this.prisma.orgSettings.upsert({ where: { id: 1 }, update: { buildNumber: { increment: 1 } }, create: { id: 1, buildNumber: 1 } }).catch(() => null);
    return `1.0.0+build.${(org as any)?.buildNumber ?? 1}`;
  }

  private async runConfigSync(id: string, host: string, user: string, port: number, pass: string) {
    const home = `/home/${user}`;
    try {
      await this.appendDeployLog(id, `Promoting Development → Production (config only) → ${host} …`, 3);
      // 1 · deploy dev's CODE without wiping data — but ONLY if it changed since the last deploy.
      //     The skip decision asks the TARGET what it is actually running (a marker written on prod only
      //     after a VERIFIED successful rebuild), NOT a hash held on this server. A source-side hash claims
      //     "prod has X" even when prod's build failed or prod was rebuilt from an older image — which
      //     silently skips every future deploy and strands production on stale code. Unreadable/absent
      //     marker => treat as changed and ship (fail safe).
      const node = await this.prisma.clusterNode.findUnique({ where: { id } });
      const { manifest, hash: srcHash } = await this.sourceFingerprint();
      const org0 = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
      const cl = this.changelogFor(((org0 as any)?.sourceManifest ?? {}) as Record<string, string>, manifest);
      const changes = cl.summary;
      const remoteHash = (
        await sshRun(host, port, user, pass, `cat ${DEPLOY_MARKER} 2>/dev/null || true`, 30_000).catch(() => ({ stdout: '' }))
      ).stdout.trim();
      const codeUnchanged = !!srcHash && remoteHash === srcHash;
      if (codeUnchanged) {
        await this.appendDeployLog(id, '⏩ Code unchanged since the last deploy — skipping rebuild (config-only promotion, much faster).', 82);
      } else {
        await this.appendDeployLog(id, "Code changed — shipping this server's code (preserving prod's secrets & data) …", 8);
        const srcTar = await this.packageSource();
        await sshPutFile(host, port, user, pass, srcTar, `${home}/mcmf-src.tgz`);
        await fs.promises.rm(srcTar, { force: true }).catch(() => undefined);
        await sshRun(host, port, user, pass, `cp ~/mcmf/.env /tmp/.env.prod 2>/dev/null; rm -rf ~/mcmf && mkdir -p ~/mcmf && tar xzf ~/mcmf-src.tgz -C ~/mcmf && rm -f ~/mcmf-src.tgz; [ -f /tmp/.env.prod ] && cp /tmp/.env.prod ~/mcmf/.env; sed -i ${shq(`s#/home/mcmf/mcmf-certs#${home}/mcmf-certs#g`)} ~/mcmf/docker-compose.yml`, 180_000);
        await this.appendDeployLog(id, 'Rebuilding the app (no data wipe) — this takes a few minutes …', 25);
        await sshRun(host, port, user, pass, `cd ~/mcmf && rm -f /tmp/mcmf-deploy.log; nohup sh -c 'DOCKER_BUILDKIT=0 docker compose up --build -d > /tmp/mcmf-deploy.log 2>&1; echo MCMF_BUILD_DONE=$? >> /tmp/mcmf-deploy.log' >/dev/null 2>&1 </dev/null & echo started`, 20_000).catch(() => undefined);
        const deadline = Date.now() + 18 * 60_000;
        const buildStart = Date.now(), buildSpan = 18 * 60_000;
        let finished = false, buildCode: string | null = null;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15_000));
          // Interpolate the build phase across 25→80% so the bar keeps advancing while compiling.
          const pct = 25 + Math.min(55, ((Date.now() - buildStart) / buildSpan) * 55);
          await this.appendDeployLog(id, 'Rebuilding …', pct).catch(() => undefined);
          const p = await sshRun(host, port, user, pass, `sed -n 's/^MCMF_BUILD_DONE=//p' /tmp/mcmf-deploy.log 2>/dev/null | tail -1`, 40_000).catch(() => null);
          if (p && p.stdout.trim() !== '') { finished = true; buildCode = p.stdout.trim(); break; }
        }
        if (!finished) { await this.appendDeployLog(id, '❌ Code rebuild timed out.'); await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'failed' } }); return; }
        // The marker only tells us the build FINISHED — its exit code says whether it SUCCEEDED. A failed
        // build (e.g. no disk space) leaves the previous containers running, so the later "containers up"
        // check would pass and we'd record a successful deploy while prod still runs the OLD image — and,
        // worse, stamp the new hash so every future deploy skips. Treat a non-zero build as fatal.
        if (buildCode !== '0') {
          const tail = await sshRun(host, port, user, pass, `tail -25 /tmp/mcmf-deploy.log 2>/dev/null`, 40_000).catch(() => ({ stdout: '' } as any));
          await this.appendDeployLog(id, `❌ Code rebuild FAILED on ${host} (exit ${buildCode}) — production is still running the PREVIOUS build; nothing was promoted.\n${String(tail.stdout || '').slice(-900)}`);
          await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'failed' } });
          return;
        }
        // wait for the DB to be ready (api applied prisma db push on restart).
        await sshRun(host, port, user, pass, `for i in $(seq 1 40); do docker exec mcmf-std-db pg_isready -U mcmf -d mcmf 2>/dev/null | grep -q accepting && break; sleep 3; done`, 180_000).catch(() => undefined);
        // Record on the TARGET what it now actually runs — this is what the next deploy's skip check reads.
        await sshRun(host, port, user, pass, `printf '%s' ${shq(srcHash)} > ${DEPLOY_MARKER}`, 30_000).catch(() => undefined);
      }
      // 2 · promote ONLY the config tables (prod's data preserved).
      await this.appendDeployLog(id, 'Promoting config (alert rules, automations, policies, dashboards, branding) …', 88);
      const bundle = await this.buildConfigBundle();
      const tmp = `/tmp/mcmf-config-${Date.now()}.sql`;
      await fs.promises.writeFile(tmp, bundle, 'utf8');
      await sshPutFile(host, port, user, pass, tmp, `${home}/mcmf-config.sql`);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      // Capture psql's REAL exit (a pipe to tail would mask it), and the tail of its output on error.
      const apply = await sshRun(host, port, user, pass, `docker exec -i mcmf-std-db psql -U mcmf -d mcmf -v ON_ERROR_STOP=1 < ~/mcmf-config.sql > /tmp/mcmf-apply.log 2>&1; echo "APPLY=$?"; tail -4 /tmp/mcmf-apply.log; rm -f ~/mcmf-config.sql`, 180_000).catch((e) => ({ stdout: `APPLY=1 ${String((e as Error)?.message ?? e)}`, code: 1, stderr: '' }));
      const v = await sshRun(host, port, user, pass, `docker ps --format '{{.Names}}' | grep -c mcmf-std; echo '|'; docker exec mcmf-std-nginx nginx -s reload 2>/dev/null; curl -sk -o /dev/null -w '%{http_code}' https://localhost/ 2>/dev/null`, 60_000).catch(() => ({ stdout: '0|', code: 1, stderr: '' }));
      const cnt = Number((v.stdout.split('|')[0] || '').trim()) || 0;
      if (cnt >= 6 && /APPLY=0/.test(apply.stdout)) {
        // CI/CD: stamp the build version + record the deploy on BOTH this server and the target, so
        // production has an audit of which build it received and from which server (source IP/host).
        const version = await this.nextBuildVersion();
        const sourceHost = (process.env.SSO_BASE_URL || 'https://localhost').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
        const targetName = (await this.prisma.clusterNode.findUnique({ where: { id }, select: { name: true } }))?.name || host;
        await this.appendDeployLog(id, `🏷 Build ${version} promoted to ${targetName} (${host}) from ${sourceHost}.`, 99);
        await this.appendDeployLog(id, '✅ Config promoted to Production. Prod identity/2FA, connections, VMs and history preserved.', 100);
        await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'deployed', lastSyncAt: new Date(), lastDeployVersion: version, lastDeploySource: sourceHost, lastDeployAt: new Date(), lastDeployHash: srcHash } as any });
        await this.prisma.deployRecord.create({ data: { version, kind: 'config-sync', sourceHost, targetHost: host, targetName, status: 'deployed', changes, files: cl.files as any } as any }).catch(() => undefined);
        // Keep only the latest 5 history rows.
        await this.prisma.$executeRawUnsafe(`DELETE FROM "DeployRecord" WHERE id NOT IN (SELECT id FROM "DeployRecord" ORDER BY "createdAt" DESC LIMIT 5)`).catch(() => undefined);
        // Remember this deploy's file manifest so the NEXT deploy can diff against it for the changelog.
        await this.prisma.orgSettings.update({ where: { id: 1 }, data: { sourceManifest: manifest as any } }).catch(() => undefined);
        // Mirror the record onto the TARGET (production) DB so it independently records the update it
        // received + the source server + the changelog. Best-effort — this server's audit is source of truth.
        const drId = `dr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const esc = (s: string) => String(s).replace(/'/g, "''");
        const sql = `INSERT INTO \\"DeployRecord\\" (id,version,kind,\\"sourceHost\\",\\"targetHost\\",\\"targetName\\",\\"actorEmail\\",status,changes,\\"createdAt\\") VALUES ('${drId}','${esc(version)}','config-sync','${esc(sourceHost)}','${esc(host)}','${esc(targetName)}','','deployed','${esc(changes)}',now());`;
        await sshRun(host, port, user, pass, `docker exec -i mcmf-std-db psql -U mcmf -d mcmf -c "${sql}"`, 30_000).catch(() => undefined);
        // Prune prod's history to the latest 5 too.
        await sshRun(host, port, user, pass, `docker exec -i mcmf-std-db psql -U mcmf -d mcmf -c "DELETE FROM \\"DeployRecord\\" WHERE id NOT IN (SELECT id FROM \\"DeployRecord\\" ORDER BY \\"createdAt\\" DESC LIMIT 5)"`, 30_000).catch(() => undefined);
      } else {
        await this.appendDeployLog(id, `❌ Config promotion failed — ${cnt}/7 up.\n${(apply.stdout || '').slice(-500)}`);
        await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'failed' } });
      }
    } catch (e: any) {
      await this.appendDeployLog(id, `❌ ${String(e?.message ?? e).slice(0, 300)}`);
      await this.prisma.clusterNode.update({ where: { id }, data: { deployStatus: 'failed' } }).catch(() => undefined);
    }
  }

  // ── Full system snapshot (docker images + source code + database in one archive) ──────────
  private dockerApi(apiPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: '/var/run/docker.sock', path: apiPath, method: 'GET', timeout: 30_000 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('docker socket timeout')));
      req.end();
    });
  }

  /** Image refs of the app's BUILT containers (api + web). Base images are re-pulled on restore. */
  private async builtImages(): Promise<string[]> {
    const r = await this.dockerApi('/containers/json?all=1').catch(() => ({ status: 0, body: '[]' }));
    if (r.status >= 400) return [];
    const list = JSON.parse(r.body || '[]') as any[];
    const imgs = new Set<string>();
    for (const c of list) {
      const names = (c.Names || []).map((n: string) => n.replace(/^\//, ''));
      if (names.some((n: string) => n === 'mcmf-std-api' || n === 'mcmf-std-web')) imgs.add(c.Image);
    }
    return [...imgs];
  }

  private dockerSaveImages(images: string[], outPath: string): Promise<void> {
    const qs = images.map((i) => `names=${encodeURIComponent(i)}`).join('&');
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: '/var/run/docker.sock', path: `/images/get?${qs}`, method: 'GET' }, (res) => {
        if ((res.statusCode ?? 0) >= 400) { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => reject(new Error(`docker images/get ${res.statusCode}: ${b.slice(0, 200)}`))); return; }
        const ws = fs.createWriteStream(outPath);
        res.pipe(ws);
        ws.on('finish', () => resolve());
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Produce a complete, restore-anywhere snapshot: the app's built docker images + full source code +
   * a fresh DB dump, bundled into one archive in the backup volume. (Base images like postgres/nginx
   * are standard and re-pulled by `docker compose up` on restore.)
   */
  async fullSnapshot() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const work = `/tmp/mcmf-full-${Date.now()}`;
    await fs.promises.mkdir(work, { recursive: true });
    try {
      // 1 · database dump
      const snap = await this.backupNow();
      await fs.promises.copyFile(path.join(BACKUP_DIR, snap.name), path.join(work, 'db.sql.gz'));
      // 2 · source code
      let hasSrc = false;
      if (fs.existsSync('/opt/mcmf-src/docker-compose.yml')) {
        await execFileP('sh', ['-c', `cd /opt/mcmf-src && tar czf ${work}/source.tgz --exclude=node_modules --exclude=.git --exclude=dist --exclude=.next --exclude=coverage --exclude='*.tgz' --exclude='*.tar.gz' .`], { timeout: 120_000 });
        hasSrc = true;
      }
      // 3 · built app images
      const images = await this.builtImages();
      if (images.length) await this.dockerSaveImages(images, path.join(work, 'images.tar'));
      // 4 · a small manifest + bundle everything
      const manifest = { createdAt: new Date().toISOString(), images, includes: { db: true, source: hasSrc, images: images.length > 0 }, note: 'Restore: load images.tar (docker load), extract source.tgz, then docker compose up -d and restore db.sql.gz. Base images (postgres/nginx/clickhouse/guacd) are re-pulled automatically.' };
      await fs.promises.writeFile(path.join(work, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
      const out = path.join(BACKUP_DIR, `mcmf-full-${ts}.tar`);
      await execFileP('sh', ['-c', `cd ${work} && tar cf ${out} .`], { timeout: 600_000 });
      const st = await fs.promises.stat(out);
      const external = await this.copyToExternal(out);
      return { ok: true, name: path.basename(out), bytes: st.size, at: st.mtime.toISOString(), images: images.length, source: hasSrc, external };
    } catch (e) {
      throw new BadRequestException(`full snapshot failed: ${String((e as any)?.stderr || (e as Error)?.message || e).slice(0, 240)}`);
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
