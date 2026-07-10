import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { sshRun } from '../database/ssh-deploy';
import { decryptJson, encryptJson } from '../../connectors/crypto';

type Dir = 'p2s' | 'p2t' | 's2t';

/**
 * Replication-agent build version. Baked into the served scripts (Linux + Windows) and returned on
 * every check-in. When the agent's local version differs, it self-updates (re-downloads + restarts).
 * BUMP THIS whenever the agent script logic changes so deployed agents auto-upgrade.
 */
export const REPL_AGENT_VERSION = '1.0.0';

// Fixed key locations the agents create + MCMF references in push commands (key-based SSH auth).
const KEY_PATH_LINUX = '/opt/mcmf-repl/id_ed25519';
const KEY_PATH_WIN = 'C:\\ProgramData\\MCMF-Repl\\id_ed25519';

/**
 * Replication / DR orchestration. MCMF is the control + status plane: it stores replication sets
 * (primary/secondary/tertiary VMs), drives the file engine (rsync over SSH using vault credentials),
 * records run history, and exposes promote/failover. DNS repointing is the operator's job (external).
 */
@Injectable()
export class ReplicationService implements OnModuleInit {
  private readonly log = new Logger('Replication');
  private running = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Scheduled/async sets on a 60s tick; near-sync (mode=sync) sets on a 15s fast tick. True RPO-0 is
    // the DRBD (dataType=block) path — its provision is idempotent, so the 60s tick just health-heals it.
    setInterval(() => this.tick().catch((e) => this.log.warn(`tick: ${String((e as Error)?.message ?? e)}`)), 60_000);
    setInterval(() => this.fastTick().catch((e) => this.log.warn(`fastTick: ${String((e as Error)?.message ?? e)}`)), 15_000);
  }

  private async tick() {
    const sets = await this.prisma.replicationSet.findMany({ where: { enabled: true, state: 'primary-active' } }).catch(() => []);
    const now = Date.now();
    for (const s of sets) {
      if (this.running.has(s.id)) continue;
      if (s.driver === 'agent') continue; // agent-driven: the installed agent runs it locally + reports
      if (s.mode === 'sync' && s.dataType !== 'block') continue; // near-sync handled by fastTick (block heals here)
      const dueEvery = s.mode === 'scheduled' ? s.intervalMin : Math.max(1, Math.min(s.intervalMin, 5)); // async ships deltas more often
      const last = s.lastRunAt ? s.lastRunAt.getTime() : 0;
      if (now - last >= dueEvery * 60_000) this.runNow(s.id, 'p2s').catch(() => undefined);
    }
  }

  /** Near-sync: run mode=sync sets (rsync/dump/docker) every intervalSec (default 30s, min 10s). */
  private async fastTick() {
    const sets = await this.prisma.replicationSet.findMany({ where: { enabled: true, state: 'primary-active', mode: 'sync', driver: { not: 'agent' } } }).catch(() => []);
    const now = Date.now();
    for (const s of sets) {
      if (s.dataType === 'block') continue; // DRBD is continuous — no periodic copy
      if (this.running.has(s.id)) continue;
      const everySec = s.intervalSec > 0 ? Math.max(10, s.intervalSec) : 30;
      const last = s.lastRunAt ? s.lastRunAt.getTime() : 0;
      if (now - last >= everySec * 1000) this.runNow(s.id, 'p2s').catch(() => undefined);
    }
  }

  private async sshCred(host: string): Promise<{ username: string; password: string; port: number } | null> {
    if (!host) return null;
    // Host + username are interpolated into shell commands (ssh/scp/rsync); enforce a strict charset
    // at this single choke point so a crafted host/username can never break out and inject commands.
    if (!/^[A-Za-z0-9.:_-]+$/.test(host)) throw new BadRequestException(`Unsafe host "${host}".`);
    const c = await this.prisma.vmCredential.findFirst({ where: { host, protocol: 'ssh' } });
    if (!c) return null;
    if (!/^[A-Za-z0-9._@-]+$/.test(c.username)) throw new BadRequestException(`Unsafe SSH username "${c.username}".`);
    let password = '';
    try { password = decryptJson<string>(c.password); } catch { /* key-auth or undecryptable */ }
    return { username: c.username, password, port: 22 };
  }

  private hostOf(r: any): string {
    const p = (r?.properties ?? {}) as any;
    return p.privateIp || p.ip || p.publicIp || p.ipAddress || r?.name || '';
  }

  async list() {
    const sets = await this.prisma.replicationSet.findMany({ orderBy: { createdAt: 'desc' }, include: { runs: { orderBy: { startedAt: 'desc' }, take: 5 } } });
    const agents = await (this.prisma as any).replicationAgent.findMany().catch(() => []);
    const now = Date.now();
    const agentFor = (host: string) => {
      const a = agents.find((x: any) => x.host === host);
      if (!a) return null;
      const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      return { host: a.host, os: a.os, version: a.version, online: now - seen < 180_000, lastSeenAt: a.lastSeenAt ? new Date(a.lastSeenAt).toISOString() : null };
    };
    return sets.map((s) => ({
      id: s.id, name: s.name, dataType: s.dataType, mode: s.mode,
      primaryId: s.primaryId, primaryName: s.primaryName, primaryHost: s.primaryHost,
      secondaryId: s.secondaryId, secondaryName: s.secondaryName, secondaryHost: s.secondaryHost,
      tertiaryId: s.tertiaryId, tertiaryName: s.tertiaryName, tertiaryHost: s.tertiaryHost,
      sourcePath: s.sourcePath, targetPath: s.targetPath, dbEngine: s.dbEngine, dbName: s.dbName, dockerVolumes: s.dockerVolumes, driver: s.driver, intervalMin: s.intervalMin, intervalSec: s.intervalSec,
      blockDevice: s.blockDevice, blockDeviceB: s.blockDeviceB, drbdPort: s.drbdPort, drbdMinor: s.drbdMinor, drbdMount: s.drbdMount,
      enabled: s.enabled, status: this.running.has(s.id) ? 'running' : s.status, state: s.state,
      lastError: s.lastError,
      primaryAgent: agentFor(s.primaryHost), secondaryAgent: agentFor(s.secondaryHost),
      lagSeconds: s.lastOkAt ? Math.round((now - s.lastOkAt.getTime()) / 1000) : null,
      lastRunAt: s.lastRunAt?.toISOString() ?? null, lastOkAt: s.lastOkAt?.toISOString() ?? null,
      runs: s.runs.map((r) => ({ id: r.id, direction: r.direction, ok: r.ok, durationMs: r.durationMs, detail: r.detail, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null })),
    }));
  }

  async create(body: any) {
    const ids = [body.primaryId, body.secondaryId, body.tertiaryId].filter(Boolean);
    const res = await this.prisma.resource.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, properties: true } });
    const byId = new Map(res.map((r) => [r.id, r]));
    const p = byId.get(body.primaryId), s = byId.get(body.secondaryId), t = body.tertiaryId ? byId.get(body.tertiaryId) : null;
    if (!p || !s) throw new BadRequestException('Pick a primary and a secondary VM from the inventory.');
    if (p.id === s.id) throw new BadRequestException('Primary and secondary must be different VMs.');
    return this.prisma.replicationSet.create({
      data: {
        name: String(body.name || 'replication').slice(0, 80),
        dataType: ['files', 'database', 'docker', 'block'].includes(body.dataType) ? body.dataType : 'files',
        mode: ['sync', 'async', 'scheduled'].includes(body.mode) ? body.mode : 'scheduled',
        primaryId: p.id, primaryName: p.name, primaryHost: this.hostOf(p),
        secondaryId: s.id, secondaryName: s.name, secondaryHost: this.hostOf(s),
        tertiaryId: t?.id ?? '', tertiaryName: t?.name ?? '', tertiaryHost: t ? this.hostOf(t) : '',
        sourcePath: String(body.sourcePath || '').slice(0, 300),
        targetPath: String(body.targetPath || '').slice(0, 300),
        dbEngine: ['postgres', 'mysql'].includes(body.dbEngine) ? body.dbEngine : 'postgres',
        dbName: String(body.dbName || '').slice(0, 120),
        dbUser: String(body.dbUser || '').slice(0, 120),
        dbPassword: body.dbPassword ? encryptJson(String(body.dbPassword)) : '',
        dockerVolumes: String(body.dockerVolumes || '').slice(0, 500),
        blockDevice: String(body.blockDevice || '').slice(0, 200),
        blockDeviceB: String(body.blockDeviceB || '').slice(0, 200),
        drbdPort: Math.max(1, Math.min(65535, Number(body.drbdPort) || 7789)),
        drbdMinor: Math.max(0, Math.min(255, Number(body.drbdMinor) || 0)),
        drbdMount: String(body.drbdMount || '').slice(0, 200),
        driver: body.driver === 'agent' ? 'agent' : 'orchestrated',
        intervalMin: Math.max(1, Math.min(1440, Number(body.intervalMin) || 15)),
        intervalSec: Math.max(0, Math.min(3600, Number(body.intervalSec) || 0)),
      },
    });
  }

  async update(id: string, body: any) {
    const data: any = {};
    for (const k of ['name', 'dataType', 'mode', 'sourcePath', 'targetPath'] as const) if (body[k] !== undefined) data[k] = String(body[k]).slice(0, 300);
    if (body.intervalMin !== undefined) data.intervalMin = Math.max(1, Math.min(1440, Number(body.intervalMin) || 15));
    if (body.enabled !== undefined) data.enabled = !!body.enabled;
    return this.prisma.replicationSet.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.prisma.replicationSet.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }

  private drbdRes(set: any) { return 'mcmf' + String(set.id).replace(/[^a-zA-Z0-9]/g, '').slice(-8); }

  /**
   * DRBD (synchronous block replication, protocol C = RPO 0). Idempotent provision + status: installs
   * drbd-utils, writes the resource, brings it up on BOTH nodes, makes the active side Primary, and
   * reports drbdadm status. The backing device must be a DEDICATED block device/LVM volume on both
   * hosts (DRBD's internal metadata overwrites the tail of the device). "Sync now" re-runs this safely.
   */
  private async provisionDrbd(set: any): Promise<{ ok: boolean; detail: string }> {
    const primaryHost = set.state === 'failed-over' ? set.secondaryHost : set.primaryHost;
    const secondaryHost = set.state === 'failed-over' ? set.primaryHost : set.secondaryHost;
    if (!set.primaryHost || !set.secondaryHost) throw new Error('Primary/secondary host is not set.');
    if (!set.blockDevice) throw new Error('No backing block device set (e.g. /dev/sdb or /dev/vg0/lv). It must be a DEDICATED device on both hosts.');
    const cA = await this.sshCred(set.primaryHost), cB = await this.sshCred(set.secondaryHost);
    if (!cA) throw new Error(`No SSH credential for ${set.primaryHost} — add it in Credential Vault.`);
    if (!cB) throw new Error(`No SSH credential for ${set.secondaryHost} — add it in Credential Vault.`);
    const res = this.drbdRes(set), minor = set.drbdMinor || 0, port = set.drbdPort || 7789;
    const devA = set.blockDevice, devB = set.blockDeviceB || set.blockDevice;
    // DRBD's `on <name>` must match each node's `uname -n`.
    const nA = (await sshRun(set.primaryHost, cA.port, cA.username, cA.password, 'uname -n', 20_000).catch(() => ({ stdout: '' }))).stdout.trim().split(/\s+/)[0];
    const nB = (await sshRun(set.secondaryHost, cB.port, cB.username, cB.password, 'uname -n', 20_000).catch(() => ({ stdout: '' }))).stdout.trim().split(/\s+/)[0];
    if (!nA || !nB) throw new Error('Could not read the hostnames (uname -n) of both nodes over SSH.');
    const resFile = [
      `resource ${res} {`,
      `  net { protocol C; verify-alg sha256; csums-alg sha256; }`,
      `  on ${nA} { device /dev/drbd${minor}; disk ${devA}; address ${set.primaryHost}:${port}; meta-disk internal; }`,
      `  on ${nB} { device /dev/drbd${minor}; disk ${devB}; address ${set.secondaryHost}:${port}; meta-disk internal; }`,
      `}`,
      ``,
    ].join('\n');
    const b64 = Buffer.from(resFile).toString('base64');
    const provision = (dev: string) =>
      `command -v drbdadm >/dev/null 2>&1 || { ` +
      `  if command -v apt-get >/dev/null 2>&1; then apt-get update -y >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y drbd-utils >/dev/null 2>&1; ` +
      `  elif command -v dnf >/dev/null 2>&1; then dnf install -y drbd-utils >/dev/null 2>&1; ` +
      `  elif command -v yum >/dev/null 2>&1; then yum install -y drbd-utils >/dev/null 2>&1; fi; }; ` +
      `command -v drbdadm >/dev/null 2>&1 || { echo MCMF_NO_DRBD; exit 11; }; ` +
      `[ -b ${dev} ] || { echo MCMF_NO_DEV; exit 12; }; ` +
      `modprobe drbd 2>/dev/null || true; mkdir -p /etc/drbd.d; echo ${b64} | base64 -d > /etc/drbd.d/${res}.res; ` +
      `drbdadm up ${res} 2>/dev/null || { drbdadm create-md --force ${res} >/dev/null 2>&1 && drbdadm up ${res}; }; echo MCMF_DRBD_UP`;
    const rB = await sshRun(set.secondaryHost, cB.port, cB.username, cB.password, provision(devB), 180_000);
    if (/MCMF_NO_DRBD/.test(rB.stdout)) throw new Error(`drbd-utils could not be installed on ${set.secondaryHost}.`);
    if (/MCMF_NO_DEV/.test(rB.stdout)) throw new Error(`Backing device ${devB} is not a block device on ${set.secondaryHost}.`);
    const rA = await sshRun(set.primaryHost, cA.port, cA.username, cA.password, provision(devA), 180_000);
    if (/MCMF_NO_DRBD/.test(rA.stdout)) throw new Error(`drbd-utils could not be installed on ${set.primaryHost}.`);
    if (/MCMF_NO_DEV/.test(rA.stdout)) throw new Error(`Backing device ${devA} is not a block device on ${set.primaryHost}.`);
    if (!/MCMF_DRBD_UP/.test(rA.stdout) || !/MCMF_DRBD_UP/.test(rB.stdout)) throw new Error(`DRBD did not come up:\nA: ${rA.stdout.slice(-200)}\nB: ${rB.stdout.slice(-200)}`);
    // make the active side Primary (force on first bring-up to seed the initial full sync)
    const cP = primaryHost === set.primaryHost ? cA : cB;
    const promote = `drbdadm primary ${res} 2>/dev/null || drbdadm primary --force ${res} 2>/dev/null; sleep 1; drbdadm status ${res} 2>&1 | head -24; echo MCMF_DRBD_STATUS`;
    const rP = await sshRun(primaryHost, cP.port, cP.username, cP.password, promote, 60_000);
    const status = (rP.stdout || '').replace(/MCMF_DRBD_STATUS/g, '').trim();
    const ok = /(UpToDate|SyncSource|SyncTarget|Established|Connected)/i.test(status);
    const detail = `resource ${res} (protocol C, /dev/drbd${minor}) — primary=${primaryHost}\n${status.slice(0, 1200)}`;
    return { ok, detail };
  }

  /** Execute one replication hop now. files → rsync over SSH (source pushes to target). */
  async runNow(id: string, direction: Dir = 'p2s') {
    const set = await this.prisma.replicationSet.findUnique({ where: { id } });
    if (!set) throw new BadRequestException('replication set not found');
    if (this.running.has(id)) return { ok: false, detail: 'A run is already in progress for this set.' };
    this.running.add(id);
    const run = await this.prisma.replicationRun.create({ data: { setId: id, direction } });
    await this.prisma.replicationSet.update({ where: { id }, data: { status: 'running', lastRunAt: new Date() } });
    const t0 = Date.now();
    let ok = false, detail = '';
    try {
      if (set.dataType === 'block') {
        const r = await this.provisionDrbd(set);
        ok = r.ok; detail = r.detail;
      } else if (set.dataType === 'database') {
        const [srcHost, tgtHost] = direction === 'p2t' ? [set.primaryHost, set.tertiaryHost] : direction === 's2t' ? [set.secondaryHost, set.tertiaryHost] : [set.primaryHost, set.secondaryHost];
        if (!srcHost || !tgtHost) throw new Error('Source/target host is not set on this replication set.');
        const srcCred = await this.sshCred(srcHost);
        const tgtCred = await this.sshCred(tgtHost);
        if (!srcCred) throw new Error(`No SSH credential for the source host ${srcHost} — add it in Credential Vault.`);
        if (!tgtCred) throw new Error(`No SSH credential for the target host ${tgtHost} — add it in Credential Vault.`);
        if (!set.dbName) throw new Error('No database name set on this replication set.');
        const q = (s: string) => String(s).replace(/'/g, "'\\''");
        let dbpass = '';
        try { dbpass = set.dbPassword ? decryptJson<string>(set.dbPassword) : ''; } catch { /* peer auth */ }
        const db = q(set.dbName);
        const u = set.dbUser ? `-U '${q(set.dbUser)}'` : '';
        const isMy = set.dbEngine === 'mysql';
        // Source: logical dump → scp to target (rm the temp). Then target: restore.
        const dumpCmd = isMy
          ? `command -v mysqldump >/dev/null 2>&1 || { echo MCMF_NO_TOOL; exit 11; }; ${dbpass ? `MYSQL_PWD='${q(dbpass)}' ` : ''}mysqldump --single-transaction --quick ${set.dbUser ? `-u '${q(set.dbUser)}'` : ''} '${db}' > /tmp/mcmf-repl.sql`
          : `command -v pg_dump >/dev/null 2>&1 || { echo MCMF_NO_TOOL; exit 11; }; ${dbpass ? `PGPASSWORD='${q(dbpass)}' ` : ''}pg_dump -Fc ${u} '${db}' > /tmp/mcmf-repl.dump`;
        const tmp = isMy ? '/tmp/mcmf-repl.sql' : '/tmp/mcmf-repl.dump';
        const pushCmd = `${dumpCmd} && command -v sshpass >/dev/null 2>&1 || { echo MCMF_NO_SSHPASS; exit 12; }; sshpass -p '${q(tgtCred.password)}' scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${tmp} '${q(tgtCred.username)}@${q(tgtHost)}:${tmp}' && rm -f ${tmp} && echo MCMF_DUMP_OK`;
        const r1 = await sshRun(srcHost, srcCred.port, srcCred.username, srcCred.password, pushCmd, 300_000);
        detail = (r1.stdout || '').trim().slice(0, 1000);
        if (/MCMF_NO_TOOL/.test(detail)) throw new Error(`${isMy ? 'mysqldump' : 'pg_dump'} not found on the source host — install the DB client tools.`);
        if (/MCMF_NO_SSHPASS/.test(detail)) throw new Error('sshpass not found on the source host (needed to scp the dump) — install sshpass.');
        if (!/MCMF_DUMP_OK/.test(r1.stdout)) throw new Error(`Dump/transfer failed on the source: ${detail.slice(0, 300)}`);
        const restoreCmd = isMy
          ? `command -v mysql >/dev/null 2>&1 || { echo MCMF_NO_TOOL; exit 11; }; ${dbpass ? `MYSQL_PWD='${q(dbpass)}' ` : ''}mysql ${set.dbUser ? `-u '${q(set.dbUser)}'` : ''} '${db}' < ${tmp} 2>&1 | tail -8; rm -f ${tmp}; echo MCMF_RESTORED`
          : `command -v pg_restore >/dev/null 2>&1 || { echo MCMF_NO_TOOL; exit 11; }; ${dbpass ? `PGPASSWORD='${q(dbpass)}' ` : ''}pg_restore --clean --if-exists --no-owner ${u} -d '${db}' ${tmp} 2>&1 | tail -8; rm -f ${tmp}; echo MCMF_RESTORED`;
        const r2 = await sshRun(tgtHost, tgtCred.port, tgtCred.username, tgtCred.password, restoreCmd, 300_000);
        detail += '\n' + (r2.stdout || '').trim().slice(0, 600);
        if (/MCMF_NO_TOOL/.test(r2.stdout)) throw new Error(`${isMy ? 'mysql' : 'pg_restore'} not found on the target host.`);
        if (!/MCMF_RESTORED/.test(r2.stdout)) throw new Error('Restore failed on the target.');
        ok = true;
      } else if (set.dataType === 'docker') {
        const [srcHost, tgtHost] = direction === 'p2t' ? [set.primaryHost, set.tertiaryHost] : direction === 's2t' ? [set.secondaryHost, set.tertiaryHost] : [set.primaryHost, set.secondaryHost];
        if (!srcHost || !tgtHost) throw new Error('Source/target host is not set on this replication set.');
        const srcCred = await this.sshCred(srcHost);
        const tgtCred = await this.sshCred(tgtHost);
        if (!srcCred) throw new Error(`No SSH credential for the source host ${srcHost} — add it in Credential Vault.`);
        if (!tgtCred) throw new Error(`No SSH credential for the target host ${tgtHost} — add it in Credential Vault.`);
        const vols = (set.dockerVolumes || '').split(/[,\s]+/).map((v) => v.trim()).filter((v) => /^[A-Za-z0-9._-]+$/.test(v));
        if (!vols.length) throw new Error('No Docker volumes set (comma-separated named volumes, e.g. pgdata,appdata).');
        const q = (s: string) => String(s).replace(/'/g, "'\\''");
        const volList = vols.map((v) => `'${q(v)}'`).join(' ');
        // Source: tar each named volume's data (via a throwaway alpine container so no root path access
        // is needed) into /tmp/mcmf-dvol, then scp the dir to the target.
        const exportCmd =
          `command -v docker >/dev/null 2>&1 || { echo MCMF_NO_DOCKER; exit 11; }; ` +
          `command -v sshpass >/dev/null 2>&1 || { echo MCMF_NO_SSHPASS; exit 12; }; ` +
          `rm -rf /tmp/mcmf-dvol && mkdir -p /tmp/mcmf-dvol && ` +
          `for v in ${volList}; do docker run --rm -v "$v":/v:ro -v /tmp/mcmf-dvol:/b alpine sh -c "tar czf /b/$v.tgz -C /v . 2>/dev/null" || echo "skip:$v"; done; ` +
          `sshpass -p '${q(tgtCred.password)}' scp -r -o StrictHostKeyChecking=no -o ConnectTimeout=15 /tmp/mcmf-dvol '${q(tgtCred.username)}@${q(tgtHost)}:/tmp/mcmf-dvol' && rm -rf /tmp/mcmf-dvol && echo MCMF_DEXPORT_OK`;
        const r1 = await sshRun(srcHost, srcCred.port, srcCred.username, srcCred.password, exportCmd, 300_000);
        detail = (r1.stdout || '').trim().slice(0, 1000);
        if (/MCMF_NO_DOCKER/.test(detail)) throw new Error('docker not found on the source host.');
        if (/MCMF_NO_SSHPASS/.test(detail)) throw new Error('sshpass not found on the source host (needed to scp volumes) — install sshpass.');
        if (!/MCMF_DEXPORT_OK/.test(r1.stdout)) throw new Error(`Volume export/transfer failed on the source: ${detail.slice(0, 300)}`);
        // Target: re-create each volume and untar its data back in.
        const importCmd =
          `command -v docker >/dev/null 2>&1 || { echo MCMF_NO_DOCKER; exit 11; }; ` +
          `for f in /tmp/mcmf-dvol/*.tgz; do [ -e "$f" ] || continue; v=$(basename "$f" .tgz); docker volume create "$v" >/dev/null 2>&1; docker run --rm -v "$v":/v -v /tmp/mcmf-dvol:/b alpine sh -c "cd /v && tar xzf /b/$v.tgz" || echo "fail:$v"; done; ` +
          `rm -rf /tmp/mcmf-dvol; echo MCMF_DIMPORT_OK`;
        const r2 = await sshRun(tgtHost, tgtCred.port, tgtCred.username, tgtCred.password, importCmd, 300_000);
        detail += '\n' + (r2.stdout || '').trim().slice(0, 600);
        if (/MCMF_NO_DOCKER/.test(r2.stdout)) throw new Error('docker not found on the target host.');
        if (!/MCMF_DIMPORT_OK/.test(r2.stdout)) throw new Error('Volume import failed on the target.');
        ok = true;
      } else {
        const [srcHost, tgtHost] = direction === 'p2t' ? [set.primaryHost, set.tertiaryHost] : direction === 's2t' ? [set.secondaryHost, set.tertiaryHost] : [set.primaryHost, set.secondaryHost];
        if (!srcHost || !tgtHost) throw new Error('Source/target host is not set on this replication set.');
        const srcCred = await this.sshCred(srcHost);
        const tgtCred = await this.sshCred(tgtHost);
        if (!srcCred) throw new Error(`No SSH credential for the source host ${srcHost} — add it in Credential Vault.`);
        if (!tgtCred) throw new Error(`No SSH credential for the target host ${tgtHost} — add it in Credential Vault.`);
        const q = (s: string) => s.replace(/'/g, "'\\''");
        const src = q(set.sourcePath || '/var/www');
        const tgt = q(set.targetPath || set.sourcePath || '/var/www');
        const cmd =
          `command -v rsync >/dev/null 2>&1 || { echo MCMF_NO_RSYNC; exit 11; }; ` +
          `command -v sshpass >/dev/null 2>&1 || { echo MCMF_NO_SSHPASS; exit 12; }; ` +
          `sshpass -p '${q(tgtCred.password)}' rsync -az --delete --stats --timeout=120 ` +
          `-e 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15' '${src}/' '${q(tgtCred.username)}@${q(tgtHost)}:${tgt}/' 2>&1 | tail -24`;
        const r = await sshRun(srcHost, srcCred.port, srcCred.username, srcCred.password, cmd, 180_000);
        detail = (r.stdout || '').trim().slice(0, 1500) || 'rsync completed (no output).';
        if (/MCMF_NO_RSYNC/.test(detail)) throw new Error('rsync is not installed on the source host — install rsync, then retry.');
        if (/MCMF_NO_SSHPASS/.test(detail)) throw new Error('sshpass is not installed on the source host (needed for password SSH) — install sshpass, or use key-based credentials.');
        ok = true;
      }
    } catch (e) {
      detail = String((e as Error)?.message ?? e).slice(0, 1500);
      ok = false;
    } finally {
      this.running.delete(id);
    }
    const durationMs = Date.now() - t0;
    await this.prisma.replicationRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok, durationMs, detail } }).catch(() => undefined);
    await this.prisma.replicationSet.update({ where: { id }, data: { status: ok ? 'healthy' : 'failed', lastOkAt: ok ? new Date() : undefined, lastError: ok ? '' : detail } }).catch(() => undefined);
    return { ok, detail, durationMs };
  }

  // ---------------------------------------------------------------------------------------------
  // Standalone agent. The agent installs on the primary (+ secondary), polls /agent/checkin for the
  // jobs where its host is the active source, runs ONE self-contained source-side command locally
  // (rsync / dump+ship / docker-export+ship — DB & Docker restores are base64'd and piped into the
  // target over ssh, so there is no quote nesting), then reports the result to /agent/report.
  // MCMF stays status-only for driver=='agent' sets (the SSH scheduler skips them).
  // ---------------------------------------------------------------------------------------------

  /** Build the single source-side shell command the agent runs locally for one hop. Throws with a reason. */
  private async buildAgentCommand(set: any, direction: Dir): Promise<{ command: string; timeoutMs: number }> {
    const [tgtHost] = direction === 'p2t' ? [set.tertiaryHost] : direction === 's2t' ? [set.tertiaryHost] : [set.secondaryHost];
    if (!tgtHost) throw new Error('Target host is not set on this replication set.');
    const tgtCred = await this.sshCred(tgtHost);
    if (!tgtCred) throw new Error(`No SSH credential for the target host ${tgtHost} — add it in Credential Vault.`);
    const q = (s: string) => String(s).replace(/'/g, "'\\''");
    const tu = q(tgtCred.username);
    // key-based SSH (the agent's key is provisioned onto the target on first check-in — no sshpass).
    const SSHO = `-i '${KEY_PATH_LINUX}' -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=15`;
    // ssh into the target and run a script supplied as base64 (dodges all quoting)
    const onTarget = (script: string) =>
      `ssh ${SSHO} '${tu}@${tgtHost}' "echo ${Buffer.from(script).toString('base64')} | base64 -d | bash"`;

    if (set.dataType === 'database') {
      if (!set.dbName) throw new Error('No database name set on this replication set.');
      let dbpass = ''; try { dbpass = set.dbPassword ? decryptJson<string>(set.dbPassword) : ''; } catch { /* peer */ }
      const db = q(set.dbName), u = set.dbUser ? `-U '${q(set.dbUser)}'` : '', isMy = set.dbEngine === 'mysql';
      const tmp = isMy ? '/tmp/mcmf-repl.sql' : '/tmp/mcmf-repl.dump';
      const dump = isMy
        ? `command -v mysqldump >/dev/null 2>&1 || { echo MCMF_NO_TOOL; exit 11; }; ${dbpass ? `MYSQL_PWD='${q(dbpass)}' ` : ''}mysqldump --single-transaction --quick ${set.dbUser ? `-u '${q(set.dbUser)}'` : ''} '${db}' > ${tmp}`
        : `command -v pg_dump >/dev/null 2>&1 || { echo MCMF_NO_TOOL; exit 11; }; ${dbpass ? `PGPASSWORD='${q(dbpass)}' ` : ''}pg_dump -Fc ${u} '${db}' > ${tmp}`;
      const restore = isMy
        ? `${dbpass ? `MYSQL_PWD='${q(dbpass)}' ` : ''}mysql ${set.dbUser ? `-u '${q(set.dbUser)}'` : ''} '${db}' < ${tmp} 2>&1 | tail -8; rm -f ${tmp}; echo MCMF_RESTORED`
        : `${dbpass ? `PGPASSWORD='${q(dbpass)}' ` : ''}pg_restore --clean --if-exists --no-owner ${u} -d '${db}' ${tmp} 2>&1 | tail -8; rm -f ${tmp}; echo MCMF_RESTORED`;
      const command =
        `${dump} && scp ${SSHO} ${tmp} '${tu}@${q(tgtHost)}:${tmp}' && ` +
        `${onTarget(restore)} && rm -f ${tmp} && echo MCMF_JOB_OK`;
      return { command, timeoutMs: 600_000 };
    }
    if (set.dataType === 'docker') {
      const vols = (set.dockerVolumes || '').split(/[,\s]+/).map((v: string) => v.trim()).filter((v: string) => /^[A-Za-z0-9._-]+$/.test(v));
      if (!vols.length) throw new Error('No Docker volumes set on this replication set.');
      const volList = vols.map((v: string) => `'${q(v)}'`).join(' ');
      const importScript =
        `for f in /tmp/mcmf-dvol/*.tgz; do [ -e "$f" ] || continue; v=$(basename "$f" .tgz); docker volume create "$v" >/dev/null 2>&1; ` +
        `docker run --rm -v "$v":/v -v /tmp/mcmf-dvol:/b alpine sh -c "cd /v && tar xzf /b/$v.tgz" || echo "fail:$v"; done; rm -rf /tmp/mcmf-dvol; echo MCMF_DIMPORT_OK`;
      const command =
        `command -v docker >/dev/null 2>&1 || { echo MCMF_NO_DOCKER; exit 11; }; ` +
        `rm -rf /tmp/mcmf-dvol && mkdir -p /tmp/mcmf-dvol && ` +
        `for v in ${volList}; do docker run --rm -v "$v":/v:ro -v /tmp/mcmf-dvol:/b alpine sh -c "tar czf /b/$v.tgz -C /v . 2>/dev/null" || echo "skip:$v"; done && ` +
        `scp -r ${SSHO} /tmp/mcmf-dvol '${tu}@${q(tgtHost)}:/tmp/mcmf-dvol' && ` +
        `${onTarget(importScript)} && rm -rf /tmp/mcmf-dvol && echo MCMF_JOB_OK`;
      return { command, timeoutMs: 900_000 };
    }
    // files
    const src = q(set.sourcePath || '/var/www'), tgt = q(set.targetPath || set.sourcePath || '/var/www');
    const command =
      `command -v rsync >/dev/null 2>&1 || { echo MCMF_NO_RSYNC; exit 11; }; ` +
      `rsync -az --delete --stats --timeout=120 ` +
      `-e "ssh ${SSHO}" '${src}/' '${tu}@${q(tgtHost)}:${tgt}/' 2>&1 | tail -24 && echo MCMF_JOB_OK`;
    return { command, timeoutMs: 300_000 };
  }

  /**
   * Windows job command (cmd.exe). Uses key-based SSH (OpenSSH ships with Win10+/Server2019+) so no
   * password handling on Windows — the agent's key is provisioned onto the target first. The target
   * side is always Linux here; its restore script is base64'd + piped over ssh (no quote nesting).
   */
  private async buildWindowsCommand(set: any, direction: Dir): Promise<{ command: string; timeoutMs: number }> {
    const [tgtHost] = direction === 'p2t' ? [set.tertiaryHost] : direction === 's2t' ? [set.tertiaryHost] : [set.secondaryHost];
    if (!tgtHost) throw new Error('Target host is not set on this replication set.');
    const tgtCred = await this.sshCred(tgtHost);
    if (!tgtCred) throw new Error(`No SSH credential for the target host ${tgtHost} — add it in Credential Vault (needed once to install the agent's key).`);
    const tu = tgtCred.username;
    const SSHO = `-i "${KEY_PATH_WIN}" -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=15`;
    // Everything is PIPED through ssh (tar/dump | ssh ...) — no local staging and no scp, so Windows
    // never has to hand scp a "C:\..." path (which scp misreads as host:path). Target side is Linux.
    const sshT = (remote: string) => `ssh ${SSHO} ${tu}@${tgtHost} "${remote}"`;
    const onTarget = (script: string) => sshT(`echo ${Buffer.from(script).toString('base64')} | base64 -d | bash`);

    if (set.dataType === 'database') {
      if (!set.dbName) throw new Error('No database name set on this replication set.');
      let dbpass = ''; try { dbpass = set.dbPassword ? decryptJson<string>(set.dbPassword) : ''; } catch { /* peer */ }
      const isMy = set.dbEngine === 'mysql';
      const rtmp = isMy ? '/tmp/mcmf-repl.sql' : '/tmp/mcmf-repl.dump';
      const dump = isMy // to stdout, piped over ssh into a file on the target (no scp)
        ? `${dbpass ? `set "MYSQL_PWD=${dbpass}" && ` : ''}mysqldump --single-transaction --quick ${set.dbUser ? `-u ${set.dbUser}` : ''} ${set.dbName}`
        : `${dbpass ? `set "PGPASSWORD=${dbpass}" && ` : ''}pg_dump -Fc ${set.dbUser ? `-U ${set.dbUser}` : ''} ${set.dbName}`;
      const q = (s: string) => String(s).replace(/'/g, "'\\''");
      const restore = isMy
        ? `${dbpass ? `MYSQL_PWD='${q(dbpass)}' ` : ''}mysql ${set.dbUser ? `-u '${q(set.dbUser)}'` : ''} '${q(set.dbName)}' < ${rtmp} 2>&1 | tail -8; rm -f ${rtmp}; echo MCMF_RESTORED`
        : `${dbpass ? `PGPASSWORD='${q(dbpass)}' ` : ''}pg_restore --clean --if-exists --no-owner ${set.dbUser ? `-U '${q(set.dbUser)}'` : ''} -d '${q(set.dbName)}' ${rtmp} 2>&1 | tail -8; rm -f ${rtmp}; echo MCMF_RESTORED`;
      const command = `${dump} | ${sshT(`cat > ${rtmp}`)} && ${onTarget(restore)} && echo MCMF_JOB_OK`;
      return { command, timeoutMs: 600_000 };
    }
    if (set.dataType === 'docker') {
      const vols = (set.dockerVolumes || '').split(/[,\s]+/).map((v: string) => v.trim()).filter((v: string) => /^[A-Za-z0-9._-]+$/.test(v));
      if (!vols.length) throw new Error('No Docker volumes set on this replication set.');
      // per volume: tar the volume to stdout via a throwaway container, pipe over ssh, untar into the
      // same-named volume on the target (also via a throwaway container). No staging, no scp.
      const perVol = vols.map((v: string) =>
        `docker run --rm -v ${v}:/v:ro alpine tar czf - -C /v . | ` +
        sshT(`docker volume create ${v} >/dev/null 2>&1; docker run --rm -i -v ${v}:/v alpine tar xzf - -C /v`)).join(' && ');
      const command = `${perVol} && echo MCMF_JOB_OK`;
      return { command, timeoutMs: 900_000 };
    }
    // files: tar the source dir (bsdtar ships with Win10+/Server2019+) and pipe it over ssh into the
    // target (additive — no --delete on the tar path).
    const src = set.sourcePath || 'C:\\data';
    const tgt = (set.targetPath || set.sourcePath || '/var/www').replace(/'/g, "'\\''");
    const command = `tar czf - -C "${src}" . | ${sshT(`mkdir -p '${tgt}' && cd '${tgt}' && tar xzf -`)} && echo MCMF_JOB_OK`;
    return { command, timeoutMs: 300_000 };
  }

  /** Install the agent's SSH public key onto a target's authorized_keys, once, using vault creds. */
  private async provisionKeyOnTargets(agent: any, hosts: string[]) {
    if (!agent?.pubKey) return;
    const done = new Set(String(agent.provisioned || '').split(',').map((s: string) => s.trim()).filter(Boolean));
    const pub = String(agent.pubKey).replace(/'/g, "'\\''").replace(/[\r\n]+/g, ' ').trim();
    let changed = false;
    for (const host of hosts) {
      if (!host || done.has(host)) continue;
      const cred = await this.sshCred(host);
      if (!cred) continue; // no vault creds → can't provision; the push will just fail until creds exist
      const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qF '${pub}' ~/.ssh/authorized_keys || echo '${pub}' >> ~/.ssh/authorized_keys; echo MCMF_KEY_OK`;
      try {
        const r = await sshRun(host, cred.port, cred.username, cred.password, cmd, 30_000);
        if (/MCMF_KEY_OK/.test(r.stdout)) { done.add(host); changed = true; }
      } catch { /* leave unprovisioned; retried next check-in */ }
    }
    if (changed) await (this.prisma as any).replicationAgent.update({ where: { id: agent.id }, data: { provisioned: [...done].join(',') } }).catch(() => undefined);
  }

  /** Enroll (or re-fetch) an agent for a host; returns Linux + Windows installers + scripts. Admin only. */
  async agentEnroll(body: any) {
    const host = String(body.host || '').trim();
    if (!host) throw new BadRequestException('host is required');
    const baseUrl = String(body.baseUrl || '').replace(/\/+$/, '') || '';
    let agent = await (this.prisma as any).replicationAgent.findUnique({ where: { host } }).catch(() => null);
    if (!agent) agent = await (this.prisma as any).replicationAgent.create({ data: { host, key: randomBytes(24).toString('hex') } });
    const url = baseUrl || `https://${host}`;
    const su = (os: string) => `${url}/api/replication/agent/script?key=${agent.key}&url=${encodeURIComponent(url)}&os=${os}`;
    return {
      host, key: agent.key, version: REPL_AGENT_VERSION,
      linux: {
        scriptUrl: su('linux'),
        oneLiner: `curl -fsSk '${su('linux')}' -o /tmp/mcmf-repl-agent.sh && sudo bash /tmp/mcmf-repl-agent.sh install`,
        script: this.agentScript(agent.key, url, 'linux'),
      },
      windows: {
        scriptUrl: su('windows'),
        // run in an elevated PowerShell. -SkipCertificateCheck-equivalent handled inside the script for PS5.1.
        oneLiner: `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; iwr '${su('windows')}' -OutFile $env:TEMP\\mcmf-repl-agent.ps1; & $env:TEMP\\mcmf-repl-agent.ps1 install"`,
        script: this.agentScript(agent.key, url, 'windows'),
      },
    };
  }

  /** Serve the agent for the requested OS (windows -> PowerShell, else bash). */
  agentScript(key: string, url: string, os = 'linux'): string {
    return /^win/i.test(os) ? this.agentScriptWindows(key, url) : this.agentScriptLinux(key, url);
  }

  /** Linux bash agent: systemd timer (survives logoff/reboot), key-auth, auto-update on version drift. */
  private agentScriptLinux(key: string, url: string): string {
    const u = url.replace(/'/g, '');
    const k = String(key).replace(/[^a-f0-9]/g, '');
    return [
      `#!/usr/bin/env bash`,
      `# MCMF standalone replication agent (Linux). Polls MCMF, runs its jobs locally, reports status.`,
      `# Survives logoff/reboot via a systemd timer with restart; auto-updates when the server is newer.`,
      `set -uo pipefail`,
      `MCMF_URL='${u}'`,
      `AGENT_KEY='${k}'`,
      `VER='${REPL_AGENT_VERSION}'`,
      `HOST="\${MCMF_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"`,
      `HN="$(hostname 2>/dev/null || echo unknown)"`,
      `DIR=/opt/mcmf-repl; SELF="$DIR/agent.sh"; KEY="${KEY_PATH_LINUX}"; STAMP="$DIR/last-update"`,
      ``,
      `ensure_key() { [ -f "$KEY" ] || { mkdir -p "$DIR"; ssh-keygen -t ed25519 -N '' -f "$KEY" -C "mcmf-repl@$HN" >/dev/null 2>&1; }; }`,
      ``,
      `self_update() {`,
      `  # cooldown so a version mismatch can't loop`,
      `  if [ -f "$STAMP" ]; then now=$(date +%s); last=$(cat "$STAMP" 2>/dev/null || echo 0); [ $((now-last)) -lt 300 ] && return; fi`,
      `  date +%s > "$STAMP"`,
      `  echo "[mcmf] self-updating ($VER -> server)"; curl -fsSk "$MCMF_URL/api/replication/agent/script?key=$AGENT_KEY&url=$MCMF_URL&os=linux" -o "$SELF.new" && mv "$SELF.new" "$SELF" && chmod +x "$SELF"`,
      `  systemctl restart mcmf-repl-agent.timer 2>/dev/null || true`,
      `}`,
      ``,
      `run_once() {`,
      `  ensure_key; PUB=$(cat "$KEY.pub" 2>/dev/null || echo '')`,
      `  REQ=$(jq -nc --arg k "$AGENT_KEY" --arg h "$HOST" --arg hn "$HN" --arg v "$VER" --arg p "$PUB" '{key:$k,host:$h,os:"linux",hostname:$hn,version:$v,pubKey:$p}')`,
      `  CK=$(curl -fsSk -m 30 -X POST "$MCMF_URL/api/replication/agent/checkin" -H 'Content-Type: application/json' -d "$REQ") || { echo "checkin failed"; return; }`,
      `  SV=$(printf '%s' "$CK" | jq -r '.agentVersion // empty' 2>/dev/null)`,
      `  [ -n "$SV" ] && [ "$SV" != "$VER" ] && { self_update; return; }`,
      `  N=$(printf '%s' "$CK" | jq '.jobs | length' 2>/dev/null || echo 0)`,
      `  [ "$N" = "0" ] && { echo "no due jobs"; return; }`,
      `  for i in $(seq 0 $((N-1))); do`,
      `    SID=$(printf '%s' "$CK" | jq -r ".jobs[$i].setId"); RID=$(printf '%s' "$CK" | jq -r ".jobs[$i].runId"); CMD=$(printf '%s' "$CK" | jq -r ".jobs[$i].command")`,
      `    T0=$(date +%s%3N 2>/dev/null || echo 0)`,
      `    OUT=$(bash -c "$CMD" 2>&1); RC=$?`,
      `    T1=$(date +%s%3N 2>/dev/null || echo 0); DUR=$((T1-T0)); [ "$DUR" -lt 0 ] && DUR=0`,
      `    OK=false; { [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q MCMF_JOB_OK; } && OK=true`,
      `    BODY=$(jq -nc --arg k "$AGENT_KEY" --arg s "$SID" --arg r "$RID" --argjson ok $OK --arg o "$OUT" --argjson d $DUR '{key:$k,setId:$s,runId:$r,ok:$ok,output:$o,durationMs:$d}')`,
      `    curl -fsSk -m 30 -X POST "$MCMF_URL/api/replication/agent/report" -H 'Content-Type: application/json' -d "$BODY" >/dev/null || echo "report failed"`,
      `    echo "set $SID -> ok=$OK rc=$RC"`,
      `  done`,
      `}`,
      ``,
      `install() {`,
      `  echo "[mcmf] installing replication agent v$VER on $HOST"`,
      `  if command -v apt-get >/dev/null 2>&1; then apt-get update -y >/dev/null 2>&1 || true; apt-get install -y curl jq rsync openssh-client >/dev/null 2>&1 || true;`,
      `  elif command -v dnf >/dev/null 2>&1; then dnf install -y curl jq rsync openssh-clients >/dev/null 2>&1 || true;`,
      `  elif command -v yum >/dev/null 2>&1; then yum install -y curl jq rsync openssh-clients >/dev/null 2>&1 || true; fi`,
      `  mkdir -p "$DIR"; cp "$0" "$SELF" 2>/dev/null || curl -fsSk "$MCMF_URL/api/replication/agent/script?key=$AGENT_KEY&url=$MCMF_URL&os=linux" -o "$SELF"; chmod +x "$SELF"; ensure_key`,
      `  cat > /etc/systemd/system/mcmf-repl-agent.service <<UNIT`,
      `[Unit]`,
      `Description=MCMF replication agent`,
      `After=network-online.target`,
      `[Service]`,
      `Type=oneshot`,
      `ExecStart=/usr/bin/env bash $SELF poll`,
      `UNIT`,
      `  cat > /etc/systemd/system/mcmf-repl-agent.timer <<UNIT`,
      `[Unit]`,
      `Description=MCMF replication agent poll timer`,
      `[Timer]`,
      `OnBootSec=60`,
      `OnUnitActiveSec=60`,
      `[Install]`,
      `WantedBy=timers.target`,
      `UNIT`,
      `  systemctl daemon-reload; systemctl enable --now mcmf-repl-agent.timer >/dev/null 2>&1 || { echo "[mcmf] no systemd; nohup loop"; nohup bash -c "while true; do bash $SELF poll; sleep 60; done" >/var/log/mcmf-repl-agent.log 2>&1 & }`,
      `  echo "[mcmf] installed. Public key (share/authorize if MCMF cannot reach the target):"; cat "$KEY.pub" 2>/dev/null || true`,
      `  echo "[mcmf] logs: journalctl -u mcmf-repl-agent.service -f"`,
      `}`,
      ``,
      `case "\${1:-poll}" in`,
      `  install) install ;;`,
      `  poll) run_once ;;`,
      `  uninstall) systemctl disable --now mcmf-repl-agent.timer 2>/dev/null || true; rm -f /etc/systemd/system/mcmf-repl-agent.{service,timer}; systemctl daemon-reload 2>/dev/null || true; echo "[mcmf] removed" ;;`,
      `  *) echo "usage: $0 {install|poll|uninstall}" ;;`,
      `esac`,
      ``,
    ].join('\n');
  }

  /**
   * Windows PowerShell agent. Mirrors the monitoring agent's proven lifecycle: a SYSTEM scheduled task
   * (AtStartup + every 1 min) so it survives logoff/reboot/crash, restart-on-failure (exit protection),
   * auto-update on version drift (with a cooldown), key-based SSH via built-in OpenSSH. ASCII-only to
   * avoid the PS 5.1 ANSI encoding trap (see mcmf-agent-ps-encoding).
   */
  private agentScriptWindows(key: string, url: string): string {
    const u = url.replace(/'/g, '');
    const k = String(key).replace(/[^a-f0-9]/g, '');
    return [
      `# MCMF standalone replication agent (Windows). Runs as a SYSTEM scheduled task; survives logoff/reboot.`,
      `param([string]$Action = 'poll')`,
      `$ErrorActionPreference = 'Continue'`,
      `[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }`,
      `try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}`,
      `$MCMF = '${u}'`,
      `$KEYID = '${k}'`,
      `$VER = '${REPL_AGENT_VERSION}'`,
      `$DIR = Join-Path $env:ProgramData 'MCMF-Repl'`,
      `$SELF = Join-Path $DIR 'agent.ps1'`,
      `$KEY = Join-Path $DIR 'id_ed25519'`,
      `$STAMP = Join-Path $DIR 'last-update.txt'`,
      `$TASK = 'MCMF Replication Agent'`,
      `if (-not (Test-Path $DIR)) { New-Item -ItemType Directory -Force -Path $DIR | Out-Null }`,
      ``,
      `function Get-HostIp { try { (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress } catch { $env:COMPUTERNAME } }`,
      `function Ensure-Key {`,
      `  if (-not (Test-Path $KEY)) {`,
      `    $kg = (Get-Command ssh-keygen -ErrorAction SilentlyContinue)`,
      `    if ($kg) { & ssh-keygen -t ed25519 -N '""' -f $KEY -C ("mcmf-repl@" + $env:COMPUTERNAME) 2>$null | Out-Null }`,
      `  }`,
      `  if (Test-Path ($KEY + '.pub')) { (Get-Content ($KEY + '.pub') -Raw).Trim() } else { '' }`,
      `}`,
      `function Post-Json($path, $obj) {`,
      `  $body = ($obj | ConvertTo-Json -Compress)`,
      `  Invoke-RestMethod -Uri ($MCMF + $path) -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 30`,
      `}`,
      ``,
      `function Self-Update {`,
      `  if (Test-Path $STAMP) { $last = Get-Content $STAMP -Raw; if ($last -and ((Get-Date) - [DateTime]$last).TotalSeconds -lt 300) { return } }`,
      `  (Get-Date).ToString('o') | Set-Content $STAMP`,
      `  try {`,
      `    Invoke-WebRequest -Uri ($MCMF + '/api/replication/agent/script?key=' + $KEYID + '&url=' + [Uri]::EscapeDataString($MCMF) + '&os=windows') -OutFile ($SELF + '.new') -UseBasicParsing -TimeoutSec 30`,
      `    Move-Item -Force ($SELF + '.new') $SELF`,
      `    Write-Host '[mcmf] self-updated; next tick runs the new version'`,
      `  } catch { Write-Host ('[mcmf] self-update failed: ' + $_.Exception.Message) }`,
      `}`,
      ``,
      `function Run-Once {`,
      `  $pub = Ensure-Key`,
      `  $ck = $null`,
      `  try { $ck = Post-Json '/api/replication/agent/checkin' @{ key=$KEYID; host=(Get-HostIp); os='windows'; hostname=$env:COMPUTERNAME; version=$VER; pubKey=$pub } }`,
      `  catch { Write-Host ('[mcmf] checkin failed: ' + $_.Exception.Message); return }`,
      `  if ($ck.agentVersion -and $ck.agentVersion -ne $VER) { Write-Host ('[mcmf] server v' + $ck.agentVersion + ' != local v' + $VER); Self-Update; return }`,
      `  $jobs = @($ck.jobs)`,
      `  if ($jobs.Count -eq 0) { Write-Host 'no due jobs'; return }`,
      `  foreach ($job in $jobs) {`,
      `    $t0 = Get-Date`,
      `    $out = ''; $rc = 0`,
      `    # run the job from a temp .cmd so PowerShell never re-quotes the command (avoids quote mangling)`,
      `    $bat = Join-Path $env:TEMP ('mcmf-repl-' + $job.runId + '.cmd')`,
      `    try { Set-Content -Path $bat -Value ('@echo off' + [Environment]::NewLine + $job.command) -Encoding ASCII; $out = (& cmd.exe /c $bat 2>&1 | Out-String); $rc = $LASTEXITCODE }`,
      `    catch { $out = $_.Exception.Message; $rc = 1 }`,
      `    finally { Remove-Item $bat -Force -ErrorAction SilentlyContinue }`,
      `    $ok = ($rc -eq 0 -and $out -match 'MCMF_JOB_OK')`,
      `    $dur = [int]((Get-Date) - $t0).TotalMilliseconds`,
      `    try { Post-Json '/api/replication/agent/report' @{ key=$KEYID; setId=$job.setId; runId=$job.runId; ok=$ok; output=$out; durationMs=$dur } | Out-Null } catch { Write-Host '[mcmf] report failed' }`,
      `    Write-Host ('set ' + $job.setId + ' -> ok=' + $ok + ' rc=' + $rc)`,
      `  }`,
      `}`,
      ``,
      `function Install {`,
      `  Write-Host ('[mcmf] installing replication agent v' + $VER)`,
      `  Copy-Item -Force $PSCommandPath $SELF -ErrorAction SilentlyContinue`,
      `  if (-not (Test-Path $SELF)) { Invoke-WebRequest -Uri ($MCMF + '/api/replication/agent/script?key=' + $KEYID + '&url=' + [Uri]::EscapeDataString($MCMF) + '&os=windows') -OutFile $SELF -UseBasicParsing }`,
      `  # ensure OpenSSH client (ssh/scp/ssh-keygen) is present`,
      `  try { if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 -ErrorAction SilentlyContinue | Out-Null } } catch {}`,
      `  Ensure-Key | Out-Null`,
      `  # SYSTEM scheduled task: at startup + every 1 minute; survives logoff/reboot; restart-on-failure = exit protection`,
      `  $ps = (Get-Command powershell).Source`,
      `  $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $SELF + '" poll'`,
      `  $act = New-ScheduledTaskAction -Execute $ps -Argument $arg`,
      `  $trg = @( (New-ScheduledTaskTrigger -AtStartup) )`,
      `  $rep = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::FromDays(3650))`,
      `  $trg += $rep`,
      `  $prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest`,
      `  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)`,
      `  Register-ScheduledTask -TaskName $TASK -Action $act -Trigger $trg -Principal $prin -Settings $set -Force | Out-Null`,
      `  Start-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue`,
      `  Write-Host '[mcmf] installed as SYSTEM scheduled task (runs every 1 min, restarts on failure, survives reboot/logoff).'`,
      `  if (Test-Path ($KEY + '.pub')) { Write-Host '[mcmf] agent public key:'; Get-Content ($KEY + '.pub') }`,
      `}`,
      ``,
      `function Uninstall { Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction SilentlyContinue; Write-Host '[mcmf] removed' }`,
      ``,
      `switch ($Action) { 'install' { Install } 'poll' { Run-Once } 'uninstall' { Uninstall } default { Write-Host 'usage: agent.ps1 {install|poll|uninstall}' } }`,
      ``,
    ].join('\r\n');
  }

  /** Agent check-in: validate the key, mark the agent seen, and dispatch its due jobs (as commands). */
  async agentCheckin(body: any, ip = '') {
    const key = String(body.key || '');
    const host = String(body.host || '').trim();
    const agent = await (this.prisma as any).replicationAgent.findUnique({ where: { key } }).catch(() => null);
    if (!agent || !agent.enabled) throw new BadRequestException('unknown or disabled agent key');
    // bind the host + store the reported pubkey (used to key-provision the targets)
    const os = String(body.os || agent.os || 'linux').slice(0, 20);
    const pubKey = String(body.pubKey || '').slice(0, 4000);
    const patch: any = { lastSeenAt: new Date(), os, version: String(body.version || agent.version || '').slice(0, 20), hostname: String(body.hostname || '').slice(0, 120), lastIp: String(ip || '').slice(0, 64) };
    if (pubKey && /^ssh-/.test(pubKey)) patch.pubKey = pubKey;
    await (this.prisma as any).replicationAgent.update({ where: { id: agent.id }, data: patch }).catch(() => undefined);
    const fresh = await (this.prisma as any).replicationAgent.findUnique({ where: { id: agent.id } }).catch(() => ({ ...agent, ...patch }));
    const useHost = agent.host || host;
    const now = Date.now();
    const sets = await this.prisma.replicationSet.findMany({ where: { enabled: true, driver: 'agent', state: 'primary-active', primaryHost: useHost } }).catch(() => []);
    // provision this agent's SSH key onto every target it will push to (once), using vault creds.
    const targets = [...new Set(sets.map((s) => s.secondaryHost).filter(Boolean))];
    if (targets.length && fresh?.pubKey) await this.provisionKeyOnTargets(fresh, targets).catch(() => undefined);
    const isWin = /^win/i.test(os);
    const jobs: any[] = [];
    for (const s of sets) {
      const last = s.lastRunAt ? s.lastRunAt.getTime() : 0;
      if (now - last < s.intervalMin * 60_000) continue; // not due yet
      let built; try { built = isWin ? await this.buildWindowsCommand(s, 'p2s') : await this.buildAgentCommand(s, 'p2s'); } catch (e) {
        await this.prisma.replicationSet.update({ where: { id: s.id }, data: { status: 'failed', lastError: String((e as Error)?.message ?? e).slice(0, 500) } }).catch(() => undefined);
        continue;
      }
      // reserve the run so the next tick/check-in doesn't double-dispatch
      const run = await this.prisma.replicationRun.create({ data: { setId: s.id, direction: 'p2s' } });
      await this.prisma.replicationSet.update({ where: { id: s.id }, data: { status: 'running', lastRunAt: new Date() } }).catch(() => undefined);
      jobs.push({ setId: s.id, runId: run.id, name: s.name, command: built.command, timeoutMs: built.timeoutMs });
    }
    return { ok: true, pollSec: 60, agentVersion: REPL_AGENT_VERSION, jobs };
  }

  /** Agent reports a finished run. */
  async agentReport(body: any) {
    const agent = await (this.prisma as any).replicationAgent.findUnique({ where: { key: String(body.key || '') } }).catch(() => null);
    if (!agent) throw new BadRequestException('unknown agent key');
    await (this.prisma as any).replicationAgent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    const runId = String(body.runId || '');
    const setId = String(body.setId || '');
    const ok = !!body.ok;
    const detail = String(body.output || '').slice(0, 2000);
    const durationMs = Math.max(0, Math.min(86_400_000, Number(body.durationMs) || 0));
    if (runId) await this.prisma.replicationRun.update({ where: { id: runId }, data: { finishedAt: new Date(), ok, durationMs, detail } }).catch(() => undefined);
    if (setId) await this.prisma.replicationSet.update({ where: { id: setId }, data: { status: ok ? 'healthy' : 'failed', lastOkAt: ok ? new Date() : undefined, lastError: ok ? '' : detail } }).catch(() => undefined);
    return { ok: true };
  }

  /** Failover: mark which side is live. DNS repointing is the operator's job (external). */
  async promote(id: string, to: 'primary' | 'secondary' | 'tertiary') {
    const set = await this.prisma.replicationSet.findUnique({ where: { id } });
    if (!set) throw new BadRequestException('replication set not found');
    if (to === 'tertiary' && !set.tertiaryHost) throw new BadRequestException('No tertiary VM configured on this set.');
    const state = to === 'primary' ? 'primary-active' : to === 'tertiary' ? 'tertiary-active' : 'failed-over';
    const active = to === 'primary' ? set.primaryName : to === 'tertiary' ? set.tertiaryName : set.secondaryName;
    const activeHost = to === 'primary' ? set.primaryHost : to === 'tertiary' ? set.tertiaryHost : set.secondaryHost;
    let drbd = '';
    if (set.dataType === 'block' && to !== 'tertiary') {
      // DRBD failover: make the new active node Primary, demote the other (if reachable).
      const res = this.drbdRes(set);
      const oldHost = to === 'primary' ? set.secondaryHost : set.primaryHost;
      try {
        const cN = await this.sshCred(activeHost);
        const cO = await this.sshCred(oldHost);
        if (cO) await sshRun(oldHost, cO.port, cO.username, cO.password, `drbdadm secondary ${res} 2>/dev/null; echo done`, 30_000).catch(() => undefined);
        if (cN) { const r = await sshRun(activeHost, cN.port, cN.username, cN.password, `drbdadm primary ${res} 2>&1 || drbdadm primary --force ${res} 2>&1; drbdadm status ${res} 2>&1 | head -8`, 60_000); drbd = (r.stdout || '').trim().slice(0, 600); }
      } catch (e) { drbd = `DRBD promote note: ${String((e as Error)?.message ?? e).slice(0, 200)}`; }
    }
    await this.prisma.replicationSet.update({ where: { id }, data: { state } });
    await this.prisma.eventLog.create({ data: { type: 'finding', severity: 'warning', title: `Replication "${set.name}": promoted ${active || to} (${activeHost}) to ACTIVE. Repoint external DNS to ${activeHost}.` } }).catch(() => undefined);
    return { ok: true, state, active, activeHost, drbd, hint: `Now repoint your external DNS to ${activeHost}. MCMF does not manage DNS.` };
  }
}
