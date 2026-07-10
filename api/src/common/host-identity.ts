/**
 * Shared host-identity de-duplication.
 *
 * The same physical host can end up as several Resource rows: one keyed by IP (SSH-pull / monitor
 * enrollment), one by hostname (agent ingest), plus extras for secondary IPs. This collapses those
 * linux/windows HOST rows that share an IP or hostname into ONE merged row — used everywhere a host
 * list/count is shown (VM inventory, topology, dashboard, …) so each machine appears exactly once.
 *
 * Cloud VMs (aws/azure/gcp/docker) are left untouched — their private IPs legitimately collide across
 * accounts. Identity tokens exclude loopback, link-local, and Docker bridge ranges (172.17–172.31.x
 * are identical on every Docker host and would otherwise merge unrelated machines).
 */

export interface ResourceLike {
  id: string;
  name: string;
  provider: string;
  region?: string | null;
  status?: string | null;
  lastSeenAt?: Date | string | null;
  cpuPct?: number | null;
  properties?: any;
  [k: string]: any;
}

const norm = (t: string) => (t || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].replace(/:\d+$/, '');
const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
// Non-identity IPs: loopback, link-local, Docker bridges (172.17–172.31.x), and 0.0.0.0.
const bogusIp = (ip: string) => /^127\./.test(ip) || /^169\.254\./.test(ip) || /^172\.(1[7-9]|2[0-9]|3[01])\./.test(ip) || ip === '0.0.0.0';

export const isHostResource = (r: ResourceLike) => r.provider === 'linux' || r.provider === 'windows';

/** The routable identity IPs of a host row (name-if-IP, public/private IP, region, reported ips[]). */
export function hostIps(r: ResourceLike): string[] {
  const p = (r.properties as any) ?? {};
  const out: string[] = [];
  const add = (v: any) => { const ip = norm(String(v ?? '')); if (ip && isIp(ip) && !bogusIp(ip)) out.push(ip); };
  add(p.publicIp); add(p.privateIp); add(r.region); if (isIp(norm(r.name))) add(r.name);
  const arr = Array.isArray(p.ips) ? p.ips : String(p.ips ?? '').split(',');
  for (const x of arr) add(x);
  return [...new Set(out)];
}

/** How long a host may go without a heartbeat before it's considered down (3 missed 30s beats). */
export const HOST_FRESH_MS = 90_000;

/** Build an IP→'up'|'down' map from monitors. 'up' is authoritative (host reachable on any IP). */
export function buildMonByIp(monitors: { target?: string | null; altTargets?: string | null; status?: string | null }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const mon of monitors) {
    for (const t of [mon.target, ...String(mon.altTargets ?? '').split(',')]) {
      const ip = norm(String(t ?? ''));
      if (!ip) continue;
      if (mon.status === 'up') m.set(ip, 'up');
      else if (mon.status === 'down' && m.get(ip) !== 'up') m.set(ip, 'down');
    }
  }
  return m;
}

/**
 * Live up/down for a linux/windows HOST: running if it sent a heartbeat within freshMs OR a monitor on
 * any of its IPs is up; stopped if it's gone quiet / a monitor says down. This is reachability-based,
 * NOT the static Resource.status (which is never flipped off for hosts).
 */
export function liveHostStatus(r: ResourceLike, monByIp: Map<string, string>, freshMs = HOST_FRESH_MS): string {
  const fresh = !!r.lastSeenAt && Date.now() - new Date(r.lastSeenAt).getTime() < freshMs;
  const ips = hostIps(r);
  if (fresh || ips.some((ip) => monByIp.get(ip) === 'up')) return 'running';
  if (r.lastSeenAt || ips.some((ip) => monByIp.get(ip) === 'down')) return 'stopped';
  return r.status ?? 'stopped';
}

const hostKey = (r: ResourceLike) => { const n = norm(r.name); return isIp(n) ? '' : n; };
const ts = (r: ResourceLike) => (r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : 0);
// Prefer a row with a real hostname + agent telemetry + a recent report as the surviving identity.
const score = (r: ResourceLike) => (isIp(norm(r.name)) ? 0 : 4) + (((r.properties as any) ?? {}).agentSource ? 2 : 0) + (r.lastSeenAt ? 1 : 0);

/**
 * Collapse linux/windows host rows that share an IP or hostname into one merged row. Non-host rows
 * (cloud VMs, networks, containers) pass through unchanged. The merged row keeps the chosen primary's
 * id/name, the freshest telemetry, a union of all IPs (properties.ips), and running if any row is up.
 */
export function mergeHostResources<T extends ResourceLike>(rows: T[]): T[] {
  const hostRows = rows.filter(isHostResource);
  const rest = rows.filter((r) => !isHostResource(r));

  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const r of hostRows) parent.set(r.id, r.id);
  const owner = new Map<string, string>();
  for (const r of hostRows) {
    const hk = hostKey(r);
    const keys = [...hostIps(r), ...(hk ? ['h:' + hk] : [])];
    for (const k of keys) { const prev = owner.get(k); if (prev) union(r.id, prev); else owner.set(k, r.id); }
  }
  const groups = new Map<string, T[]>();
  for (const r of hostRows) { const g = find(r.id); (groups.get(g) ?? groups.set(g, []).get(g)!).push(r); }

  const merged = [...groups.values()].map((grp) => {
    const byFresh = [...grp].sort((a, b) => ts(b) - ts(a));
    const primary = [...grp].sort((a, b) => score(b) - score(a) || ts(b) - ts(a))[0];
    const pick = (f: string) => { for (const r of byFresh) { const v = (r as any)[f]; if (v != null) return v; } return null; };
    const pickProp = (f: string) => { for (const r of byFresh) { const v = ((r.properties as any) ?? {})[f]; if (v != null) return v; } return null; };
    const allIps = [...new Set(grp.flatMap(hostIps))];
    const pp = (primary.properties as any) ?? {};
    return {
      ...primary,
      lastSeenAt: byFresh[0]?.lastSeenAt ?? primary.lastSeenAt,
      cpuPct: pick('cpuPct'),
      memoryPct: pick('memoryPct'),
      diskPct: pick('diskPct'),
      status: grp.some((r) => r.status === 'running') ? 'running' : primary.status,
      properties: {
        ...pp,
        ips: allIps,
        publicIp: pickProp('publicIp'),
        privateIp: pp.privateIp ?? pickProp('privateIp') ?? (isIp(norm(primary.name)) ? norm(primary.name) : allIps[0] ?? null),
        agentSource: grp.some((r) => ((r.properties as any) ?? {}).agentSource),
        services: pickProp('services'),
        posture: pickProp('posture'),
        loggedInUser: pickProp('loggedInUser'),
      },
    } as T;
  });

  return [...rest, ...merged];
}
