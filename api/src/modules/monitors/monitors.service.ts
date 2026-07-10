import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { exec } from 'node:child_process';
import * as net from 'node:net';
import * as dgram from 'node:dgram';
import { collectSnmp, type SnmpState } from './snmp.collector';
import { sysParams, pInt } from '../../system-params';

// Network-device classes that unlock SNMP telemetry (bandwidth, uptime, link status, MACs).
const DEVICE_KINDS = ['host', 'firewall', 'router', 'switch', 'server', 'other'];

/**
 * Monitor protocols. Each maps to a low-level probe (tcp/http/ping/snmp) and a
 * default port so "SSH" / "RDP" etc. work as one-click presets — no need to
 * remember that SSH = tcp/22 or RDP = tcp/3389.
 */
const PROTOCOLS: Record<string, { probe: 'tcp' | 'http' | 'ping' | 'snmp' | 'agent'; port?: number; label: string }> = {
  // Reachability via a matched guest agent's heartbeat — no inbound port needed (works for
  // pure-outbound agents behind NAT). The host is "reachable" while its agent is sending data.
  agent: { probe: 'agent', label: 'Agent (heartbeat)' },
  ping: { probe: 'ping', label: 'ICMP Ping' },
  tcp: { probe: 'tcp', port: 80, label: 'TCP port' },
  http: { probe: 'http', label: 'HTTP(S)' },
  ssh: { probe: 'tcp', port: 22, label: 'SSH' },
  rdp: { probe: 'tcp', port: 3389, label: 'RDP' },
  telnet: { probe: 'tcp', port: 23, label: 'Telnet' },
  https: { probe: 'tcp', port: 443, label: 'HTTPS/TLS' },
  smtp: { probe: 'tcp', port: 25, label: 'SMTP' },
  dns: { probe: 'tcp', port: 53, label: 'DNS' },
  redfish: { probe: 'http', port: 443, label: 'Redfish (BMC)' },
  snmp: { probe: 'snmp', port: 161, label: 'SNMP' },
};
const TYPES = Object.keys(PROTOCOLS);

/** Normalize a comma/space-separated alternate-IP list (dedup, drop blanks). */
function cleanAlt(v: unknown): string {
  if (typeof v !== 'string') return '';
  return [...new Set(v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))].join(',');
}

@Injectable()
export class MonitorsService implements OnModuleInit {
  private readonly log = new Logger('Monitors');
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    setTimeout(() => this.loop(), 6000);
  }

  /** Self-rescheduling probe loop — re-reads "Monitoring check interval" from Settings → System
   *  Parameters each tick, so a change applies live (no restart). */
  private async loop() {
    await this.tick().catch(() => undefined);
    const envMs = Number(process.env.MONITOR_INTERVAL_MS);
    const sec = pInt(await sysParams(this.prisma), 'monitorIntervalSec', null, Number.isFinite(envMs) ? Math.round(envMs / 1000) : 30);
    setTimeout(() => this.loop(), Math.max(5, sec) * 1000);
  }

  // ── CRUD ──────────────────────────────────────────────
  list() {
    return this.prisma.monitor.findMany({ orderBy: [{ group: 'asc' }, { name: 'asc' }] });
  }

  /** Protocol catalogue for the UI (type → probe + default port). */
  protocols() {
    return Object.entries(PROTOCOLS).map(([type, p]) => ({ type, label: p.label, probe: p.probe, defaultPort: p.port ?? null }));
  }

  async create(b: any) {
    if (!b?.name || !b?.target) throw new BadRequestException('name and target required');
    const type = TYPES.includes(b.type) ? b.type : 'ping';
    const proto = PROTOCOLS[type];
    // Use the supplied port, else the protocol's default (SSH→22, RDP→3389, …).
    const port = b.port ? Number(b.port) : proto.port ?? null;
    const m = await this.prisma.monitor.create({
      data: {
        name: b.name,
        target: String(b.target).trim(),
        altTargets: cleanAlt(b.altTargets),
        type,
        port,
        group: (b.group || 'default').trim(),
        enabled: b.enabled !== false,
        deviceKind: DEVICE_KINDS.includes(b.deviceKind) ? b.deviceKind : 'host',
        snmpCommunity: typeof b.snmpCommunity === 'string' ? b.snmpCommunity.trim() : '',
      },
    });
    this.checkOne(m).catch(() => undefined); // immediate first check
    return m;
  }

  async update(id: string, b: any) {
    const data: any = {};
    if (b.name !== undefined) data.name = String(b.name);
    if (b.target !== undefined) data.target = String(b.target).trim();
    if (b.altTargets !== undefined) data.altTargets = cleanAlt(b.altTargets);
    if (b.group !== undefined) data.group = (b.group || 'default').trim();
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    if (b.deviceKind !== undefined && DEVICE_KINDS.includes(b.deviceKind)) data.deviceKind = b.deviceKind;
    if (b.snmpCommunity !== undefined) data.snmpCommunity = String(b.snmpCommunity).trim();
    if (b.type !== undefined && TYPES.includes(b.type)) {
      data.type = b.type;
      // Re-default the port to the new protocol unless one is explicitly given.
      data.port = b.port ? Number(b.port) : PROTOCOLS[b.type].port ?? null;
    } else if (b.port !== undefined) {
      data.port = b.port ? Number(b.port) : null;
    }
    const m = await this.prisma.monitor.update({ where: { id }, data });
    this.checkOne(m).catch(() => undefined); // re-check after a change
    return m;
  }

  /** Scope the list to a user's assigned monitor groups ([] = all). */
  async listForUser(userId?: string) {
    if (userId) {
      const u = await this.prisma.user.findUnique({ where: { id: userId } });
      const groups = Array.isArray(u?.monitorGroups) ? (u!.monitorGroups as string[]) : [];
      if (groups.length > 0) {
        return this.prisma.monitor.findMany({ where: { group: { in: groups } }, orderBy: [{ group: 'asc' }, { name: 'asc' }] });
      }
    }
    return this.list();
  }

  remove(id: string) {
    return this.prisma.monitor.delete({ where: { id } });
  }

  async checkNow() {
    await this.tick(true);
    return { ok: true };
  }

  // ── Checker ───────────────────────────────────────────
  private async tick(force = false) {
    if (this.running && !force) return;
    this.running = true;
    try {
      const monitors = await this.prisma.monitor.findMany({ where: { enabled: true } });
      await Promise.all(monitors.map((m) => this.checkOne(m)));
    } catch (err) {
      this.log.warn(`monitor tick error: ${String((err as Error)?.message ?? err)}`);
    } finally {
      this.running = false;
    }
  }

  private async checkOne(m: any) {
    const proto = PROTOCOLS[m.type] ?? PROTOCOLS.ping;
    // One device can have several IPs (e.g. public + private). Probe each in order;
    // it's UP if ANY answers — better reachability, still one monitor.
    const addrs = [m.target, ...String(m.altTargets ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)];
    let up = false;
    let latency: number | null = null;
    let lastAddress: string | null = null;
    if (proto.probe === 'agent') {
      // Reachability follows the matched agent's heartbeat — no network probe.
      const r = await this.agentReachable(m, addrs);
      up = r.up;
      lastAddress = up ? (r.address ?? m.target) : null;
    } else {
      for (const addr of addrs) {
        try {
          const start = Date.now();
          let ok = false;
          if (proto.probe === 'http') ok = await this.httpCheck(addr, m.port ?? proto.port);
          else if (proto.probe === 'tcp') ok = await this.tcpCheck(addr, m.port ?? proto.port ?? 80);
          else if (proto.probe === 'snmp') ok = await this.snmpCheck(addr, m.port ?? 161);
          else ok = await this.pingCheck(addr);
          if (ok) { up = true; latency = Date.now() - start; lastAddress = addr; break; }
        } catch { /* try the next address */ }
      }
    }

    const hist = Array.isArray(m.history) ? m.history : [];
    const history = [...hist, { ts: new Date().toISOString(), up, ms: latency }].slice(-30);
    // Jitter = mean absolute difference between consecutive RTTs (packet-delay variation).
    const lats = history.map((h: any) => h.ms).filter((v: any) => typeof v === 'number') as number[];
    let jitterMs: number | null = null;
    if (lats.length >= 2) {
      let s = 0;
      for (let i = 1; i < lats.length; i++) s += Math.abs(lats[i] - lats[i - 1]);
      jitterMs = Math.round((s / (lats.length - 1)) * 10) / 10;
    }

    await this.prisma.monitor.update({
      where: { id: m.id },
      data: { status: up ? 'up' : 'down', lastLatencyMs: latency, jitterMs, lastAddress: up ? lastAddress : null, lastCheckedAt: new Date(), history: history as any },
    });

    // Transition → raise / resolve a real device-level alert + event.
    const wasDown = m.status === 'down';
    if (!up && !wasDown) await this.onDown(m);
    else if (up && wasDown) await this.onUp(m);

    // Network device with SNMP → collect bandwidth / uptime / interfaces / connected MACs.
    if (m.snmpCommunity) await this.collectDevice(m, up ? lastAddress ?? m.target : m.target).catch((e) => this.log.warn(`snmp ${m.target}: ${String((e as Error)?.message ?? e)}`));
  }

  /** Pull SNMP telemetry from a network device, detect link up/down transitions, persist. */
  private async collectDevice(m: any, host: string) {
    const prevState = (m.snmpState && typeof m.snmpState === 'object' ? m.snmpState : {}) as SnmpState;
    const { snapshot, state } = await collectSnmp(host, m.snmpCommunity, 161, prevState);
    // Compare each interface's oper status to last poll → link up/down alerts (only on change).
    const prevStatus = new Map<number, string>((Array.isArray(m.interfaces) ? m.interfaces : []).map((i: any) => [i.index, i.status]));
    for (const i of snapshot.interfaces) {
      const before = prevStatus.get(i.index);
      if (!before || before === i.status) continue; // no transition (or first sighting)
      const src = `monitor:${m.id}:if:${i.index}`;
      if (i.status === 'down') {
        await this.prisma.alert.create({ data: { title: `Link down: ${m.name} — ${i.name}`, severity: 'high', source: src, status: 'active', resourceName: m.target, metric: 'link' } }).catch(() => undefined);
        await this.prisma.eventLog.create({ data: { type: 'system', severity: 'warning', title: `Link DOWN: ${m.name} ${i.name}`, detail: m.target } }).catch(() => undefined);
      } else {
        await this.prisma.alert.updateMany({ where: { source: src, status: { not: 'resolved' } }, data: { status: 'resolved', resolvedAt: new Date() } }).catch(() => undefined);
        await this.prisma.eventLog.create({ data: { type: 'system', severity: 'info', title: `Link UP: ${m.name} ${i.name}`, detail: m.target } }).catch(() => undefined);
      }
    }
    await this.prisma.monitor.update({
      where: { id: m.id },
      data: {
        uptimeSec: snapshot.uptimeSec,
        deviceMac: snapshot.deviceMac ?? m.deviceMac ?? null,
        interfaces: snapshot.interfaces as any,
        neighbors: snapshot.neighbors as any,
        snmpState: state as any,
        // Mark a successful poll only when the device actually answered with interface data.
        lastSnmpAt: snapshot.interfaces.length > 0 ? new Date() : m.lastSnmpAt ?? null,
      },
    }).catch(() => undefined);
    return snapshot;
  }

  // ── Network-device view (firewall / router / switch) ──────────────────
  /** Aggregated SNMP devices with derived fields for the Network Devices widget. */
  async networkDevices(userId?: string) {
    const all = await this.listForUser(userId);
    const devices = all.filter((m: any) => (m.deviceKind && m.deviceKind !== 'host') || m.snmpCommunity);
    return devices.map((m: any) => networkDeviceView(m));
  }

  /** Trigger an immediate SNMP poll of one device and report status. */
  async snmpPollNow(id: string) {
    const m = await this.prisma.monitor.findUnique({ where: { id } });
    if (!m) throw new BadRequestException('monitor not found');
    if (!m.snmpCommunity) return { ok: false, status: 'off', message: 'No SNMP community set — edit the device and add one (e.g. public).' };
    const host = m.lastAddress || m.target;
    try {
      const snapshot = await this.collectDevice(m, host);
      const fresh = await this.prisma.monitor.findUnique({ where: { id } });
      return {
        ok: !!(snapshot && snapshot.interfaces.length > 0),
        status: snapshot && snapshot.interfaces.length > 0 ? 'ok' : 'no-response',
        interfaces: snapshot?.interfaces.length ?? 0,
        connected: snapshot?.neighbors.length ?? 0,
        device: fresh ? networkDeviceView(fresh) : null,
        message: snapshot && snapshot.interfaces.length > 0
          ? `SNMP OK — ${snapshot.interfaces.length} interface(s), ${snapshot.neighbors.length} connected device(s).`
          : `No SNMP reply from ${host}:161. Check the community string and that SNMP v2c is enabled and reachable.`,
      };
    } catch (e) {
      return { ok: false, status: 'no-response', message: `SNMP poll failed: ${String((e as Error)?.message ?? e)}` };
    }
  }

  private async onDown(m: any) {
    const name = m.name ?? m.target;
    await this.prisma.alert
      .create({ data: { title: `Host down: ${name} (${m.target})`, severity: 'high', source: `monitor:${m.id}`, status: 'active', resourceName: m.target, metric: 'reachability' } })
      .catch(() => undefined);
    await this.prisma.eventLog.create({ data: { type: 'system', severity: 'critical', title: `Monitor DOWN: ${name}`, detail: m.target } }).catch(() => undefined);
  }

  private async onUp(m: any) {
    const name = m.name ?? m.target;
    await this.prisma.alert.updateMany({ where: { source: `monitor:${m.id}`, status: { not: 'resolved' } }, data: { status: 'resolved', resolvedAt: new Date() } }).catch(() => undefined);
    await this.prisma.eventLog.create({ data: { type: 'system', severity: 'info', title: `Monitor recovered: ${name}`, detail: m.target } }).catch(() => undefined);
  }

  /**
   * "Agent (heartbeat)" reachability: a host is UP while a matched guest agent is sending data
   * (heartbeat within 5 min). Matches by IP, hostname, or shared name (display name / hostname ==
   * the monitor's name) — the same link the IP/Host Monitor uses to surface agent CPU/mem/disk.
   */
  private async agentReachable(m: any, addrs: string[]): Promise<{ up: boolean; address?: string }> {
    const key = (s?: string | null) => (s ?? '').trim().toLowerCase();
    const addrSet = new Set(addrs.map(key));
    const nameKey = key(m.name);
    const agents = await this.prisma.agent.findMany({ where: { active: true } }).catch(() => [] as any[]);
    const match = agents.find((a: any) => {
      const ips = String(a.ips ?? '').split(',').map(key);
      if (ips.some((ip) => ip && addrSet.has(ip))) return true;
      if (a.hostname && addrSet.has(key(a.hostname))) return true;
      if (nameKey && (key(a.displayName) === nameKey || key(a.name) === nameKey || key(a.hostname) === nameKey)) return true;
      return false;
    });
    if (!match) return { up: false };
    const up = !!match.lastSeenAt && Date.now() - new Date(match.lastSeenAt).getTime() < 5 * 60_000;
    return { up, address: match.hostname || String(match.ips ?? '').split(',')[0] || m.target };
  }

  private pingCheck(host: string): Promise<boolean> {
    return new Promise((resolve) => {
      // -c 1 one packet, -w/-W 2s timeout. Safe target (no shell metachars).
      const safe = host.replace(/[^a-zA-Z0-9.\-:]/g, '');
      exec(`ping -c 1 -w 2 ${safe}`, { timeout: 4000 }, (err) => resolve(!err));
    });
  }

  private tcpCheck(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(3000);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  private async httpCheck(url: string, port?: number | null): Promise<boolean> {
    // Build a URL: honour an explicit scheme; otherwise default to https when the
    // port looks TLS-ish (443/redfish) else http, and append a non-standard port.
    let target: string;
    if (/^https?:\/\//.test(url)) {
      target = url;
    } else {
      const scheme = !port || port === 443 || port === 8443 ? 'https' : 'http';
      const std = (scheme === 'https' && (!port || port === 443)) || (scheme === 'http' && port === 80);
      target = `${scheme}://${url}${std || !port ? '' : `:${port}`}`;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(target, { signal: ctrl.signal, redirect: 'manual' });
      return res.status < 500; // 401/403 from a BMC still means it's alive
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /** SNMP v2c probe: send a GetRequest for sysUpTime; any well-formed reply = up. */
  private snmpCheck(host: string, port: number, community = 'public'): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch { /* already closed */ }
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 3000);
      sock.once('error', () => { clearTimeout(timer); done(false); });
      sock.once('message', (msg) => { clearTimeout(timer); done(msg.length > 2 && msg[0] === 0x30); });
      try {
        const pkt = buildSnmpGet(community, '1.3.6.1.2.1.1.3.0');
        sock.send(pkt, port, host, (err) => { if (err) { clearTimeout(timer); done(false); } });
      } catch {
        clearTimeout(timer);
        done(false);
      }
    });
  }
}

// ── Minimal SNMPv2c GetRequest encoder (BER) ─────────────────────────────
function berLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
function tlv(tag: number, value: number[]): number[] {
  return [tag, ...berLen(value.length), ...value];
}
function berInt(n: number): number[] {
  const bytes: number[] = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v = v >> 8; } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0); // keep positive
  return tlv(0x02, bytes);
}
function berOid(oid: string): number[] {
  const parts = oid.split('.').map(Number);
  const out: number[] = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    if (p < 0x80) { out.push(p); continue; }
    const stack: number[] = [];
    let v = p;
    stack.unshift(v & 0x7f);
    v >>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, out);
}
function buildSnmpGet(community: string, oid: string): Buffer {
  const varbind = tlv(0x30, [...berOid(oid), ...tlv(0x05, [])]); // OID + NULL
  const varbindList = tlv(0x30, varbind);
  const reqId = berInt(Math.floor(Math.random() * 0x7fffffff));
  const pdu = tlv(0xa0, [...reqId, ...berInt(0), ...berInt(0), ...varbindList]); // GetRequest
  const msg = tlv(0x30, [...berInt(1), ...tlv(0x04, [...Buffer.from(community)]), ...pdu]); // version v2c=1
  return Buffer.from(msg);
}

const iso = (d: any): string | null => (d == null ? null : typeof d === 'string' ? d : d.toISOString?.() ?? null);

/** Derive the Network Devices widget view from a monitor row. */
function networkDeviceView(m: any) {
  const ifaces: any[] = Array.isArray(m.interfaces) ? m.interfaces : [];
  const neighbors: any[] = Array.isArray(m.neighbors) ? m.neighbors : [];
  const ifUp = ifaces.filter((i) => i.status === 'up').length;
  const linkDown = ifaces.filter((i) => i.status === 'down').length;
  const maxUtil = ifaces.reduce((mx, i) => Math.max(mx, i.utilPct || 0), 0);
  const totalInBps = ifaces.reduce((s, i) => s + (i.inBps || 0), 0);
  const totalOutBps = ifaces.reduce((s, i) => s + (i.outBps || 0), 0);
  // "Top talkers" = the busiest ports/links (highest throughput) — where the traffic flows.
  const topTalkers = ifaces
    .map((i) => ({ name: i.name, bps: Math.max(i.inBps || 0, i.outBps || 0), inBps: i.inBps || 0, outBps: i.outBps || 0, utilPct: i.utilPct || 0 }))
    .filter((t) => t.bps > 0)
    .sort((a, b) => b.bps - a.bps)
    .slice(0, 6);
  const recent = m.lastSnmpAt ? Date.now() - new Date(m.lastSnmpAt).getTime() < 5 * 60_000 : false;
  const snmpStatus = !m.snmpCommunity ? 'off' : ifaces.length > 0 ? (recent ? 'ok' : 'stale') : 'no-response';
  return {
    id: m.id, name: m.name, target: m.target, group: m.group, deviceKind: m.deviceKind ?? 'other',
    status: m.status, snmp: !!m.snmpCommunity, snmpStatus,
    latencyMs: m.lastLatencyMs ?? null, jitterMs: m.jitterMs ?? null,
    uptimeSec: m.uptimeSec ?? null, deviceMac: m.deviceMac ?? null,
    ifTotal: ifaces.length, ifUp, linkDown, connectedCount: neighbors.length,
    maxUtilPct: Math.round(maxUtil * 10) / 10, totalInBps, totalOutBps,
    topTalkers, interfaces: ifaces, neighbors,
    lastCheckedAt: iso(m.lastCheckedAt), lastSnmpAt: iso(m.lastSnmpAt),
  };
}
