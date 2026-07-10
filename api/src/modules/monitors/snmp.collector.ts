/* eslint-disable @typescript-eslint/no-var-requires */
// SNMP v2c collector for network devices (firewall / router / switch):
//   • sysUpTime              → device uptime
//   • ifTable / ifXTable     → interface name, oper status, speed, in/out octets → bandwidth
//   • ipNetToMediaTable (ARP)→ connected device IP ↔ MAC
//   • dot1dTpFdbTable (FDB)  → switch MAC-address table (MAC ↔ port → interface)
// Pure-JS (net-snmp). Loaded via require so we don't need a separate type stub.
const snmp: any = require('net-snmp');

const OID = {
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCIn: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOut: '1.3.6.1.2.1.31.1.1.1.10',
  ifIn: '1.3.6.1.2.1.2.2.1.10',
  ifOut: '1.3.6.1.2.1.2.2.1.16',
  ifPhys: '1.3.6.1.2.1.2.2.1.6', // ifPhysAddress = the device's own interface MACs

  arpMac: '1.3.6.1.2.1.4.22.1.2', // ipNetToMediaPhysAddress, index = ifIndex.a.b.c.d
  fdbPort: '1.3.6.1.2.1.17.4.3.1.2', // dot1dTpFdbPort, index = 6 MAC octets
  basePortIf: '1.3.6.1.2.1.17.1.4.1.2', // dot1dBasePortIfIndex, index = bridge port
};

export interface SnmpIface { index: number; name: string; status: 'up' | 'down'; speedMbps: number; inBps: number; outBps: number; utilPct: number; mac?: string }
export interface SnmpNeighbor { mac: string; ip?: string; ifName?: string }
export interface SnmpSnapshot { uptimeSec: number | null; deviceMac: string | null; interfaces: SnmpIface[]; neighbors: SnmpNeighbor[] }
export interface SnmpState { ts?: number; counters?: Record<string, { in: number; out: number }> }

function toNum(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v)) {
    try { return Number(v.readBigUInt64BE(0)); } catch { let n = 0; for (const b of v) n = n * 256 + b; return n; }
  }
  return Number(v) || 0;
}
function toStr(v: any): string { return Buffer.isBuffer(v) ? v.toString('utf8').replace(/\0+$/g, '').trim() : String(v ?? ''); }
function toMac(v: any): string {
  if (Buffer.isBuffer(v) && v.length === 6) return [...v].map((b) => b.toString(16).padStart(2, '0')).join(':');
  return '';
}

/** Walk an SNMP column (subtree) → rows of { idx (sub-oid under base), value }. Best-effort. */
function walk(session: any, base: string): Promise<{ idx: string; value: any }[]> {
  return new Promise((resolve) => {
    const rows: { idx: string; value: any }[] = [];
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(rows); };
    const timer = setTimeout(finish, 8000);
    try {
      session.subtree(base, 20, (vbs: any[]) => {
        for (const vb of vbs) {
          if (snmp.isVarbindError(vb)) continue;
          const oid: string = vb.oid;
          if (typeof oid === 'string' && oid.startsWith(base + '.')) rows.push({ idx: oid.slice(base.length + 1), value: vb.value });
        }
      }, () => finish());
    } catch { finish(); }
  });
}

const mapBy = <T>(rows: { idx: string; value: any }[], f: (v: any) => T): Map<string, T> => {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.idx, f(r.value));
  return m;
};

export async function collectSnmp(host: string, community: string, port: number, prev: SnmpState): Promise<{ snapshot: SnmpSnapshot; state: SnmpState }> {
  let session: any;
  try {
    session = snmp.createSession(host, community || 'public', { port: port || 161, version: snmp.Version2c, timeout: 4000, retries: 1 });
  } catch {
    return { snapshot: { uptimeSec: null, deviceMac: null, interfaces: [], neighbors: [] }, state: prev ?? {} };
  }
  try {
    let uptimeSec: number | null = null;
    await new Promise<void>((resolve) => {
      try {
        session.get([OID.sysUpTime], (err: any, vbs: any[]) => {
          if (!err && vbs && vbs[0] && !snmp.isVarbindError(vbs[0])) uptimeSec = Math.round(toNum(vbs[0].value) / 100);
          resolve();
        });
      } catch { resolve(); }
    });

    const [descr, names, oper, speed, high, hcIn, hcOut, in32, out32, phys, arp, fdb, basePort] = await Promise.all([
      walk(session, OID.ifDescr), walk(session, OID.ifName), walk(session, OID.ifOperStatus),
      walk(session, OID.ifSpeed), walk(session, OID.ifHighSpeed),
      walk(session, OID.ifHCIn), walk(session, OID.ifHCOut), walk(session, OID.ifIn), walk(session, OID.ifOut),
      walk(session, OID.ifPhys), walk(session, OID.arpMac), walk(session, OID.fdbPort), walk(session, OID.basePortIf),
    ]);

    const descrM = mapBy(descr, toStr), nameM = mapBy(names, toStr), operM = mapBy(oper, toNum);
    const speedM = mapBy(speed, toNum), highM = mapBy(high, toNum);
    const hcInM = mapBy(hcIn, toNum), hcOutM = mapBy(hcOut, toNum), in32M = mapBy(in32, toNum), out32M = mapBy(out32, toNum);
    const physM = mapBy(phys, toMac);

    const now = Date.now();
    const prevCounters = prev?.counters ?? {};
    const dt = prev?.ts ? Math.max(1, (now - prev.ts) / 1000) : 0;
    const counters: Record<string, { in: number; out: number }> = {};
    const interfaces: SnmpIface[] = [];
    const idxs = new Set<string>([...descrM.keys(), ...nameM.keys(), ...operM.keys()]);
    for (const idx of idxs) {
      const inOct = hcInM.get(idx) ?? in32M.get(idx) ?? 0;
      const outOct = hcOutM.get(idx) ?? out32M.get(idx) ?? 0;
      counters[idx] = { in: inOct, out: outOct };
      let inBps = 0, outBps = 0;
      const p = prevCounters[idx];
      if (dt > 0 && p) {
        const di = inOct - p.in, do_ = outOct - p.out;
        inBps = di >= 0 ? Math.round((di * 8) / dt) : 0; // ignore counter wrap/reset
        outBps = do_ >= 0 ? Math.round((do_ * 8) / dt) : 0;
      }
      const speedMbps = highM.get(idx) ? highM.get(idx)! : Math.round((speedM.get(idx) ?? 0) / 1e6);
      const cap = speedMbps * 1e6;
      const utilPct = cap > 0 ? Math.round((Math.max(inBps, outBps) / cap) * 1000) / 10 : 0;
      interfaces.push({ index: Number(idx), name: nameM.get(idx) || descrM.get(idx) || `if${idx}`, status: operM.get(idx) === 1 ? 'up' : 'down', speedMbps, inBps, outBps, utilPct, mac: physM.get(idx) || undefined });
    }
    interfaces.sort((a, b) => a.index - b.index);
    const ifNameOf = (i?: number) => interfaces.find((x) => x.index === i)?.name;
    // The device's own MAC = first real (non-zero) interface physical address.
    const deviceMac = interfaces.map((i) => i.mac).find((mc) => mc && mc !== '00:00:00:00:00:00') ?? null;

    // Connected devices: ARP gives MAC↔IP↔ifIndex; FDB gives MAC↔bridgePort→ifIndex.
    const basePortToIf = new Map<string, number>();
    for (const r of basePort) basePortToIf.set(r.idx, toNum(r.value));
    const neigh = new Map<string, SnmpNeighbor>();
    for (const r of arp) {
      const parts = r.idx.split('.');
      const ifIndex = Number(parts[0]);
      const ip = parts.slice(1).join('.');
      const mac = toMac(r.value);
      if (mac) neigh.set(mac, { mac, ip, ifName: ifNameOf(ifIndex) });
    }
    for (const r of fdb) {
      const parts = r.idx.split('.');
      if (parts.length < 6) continue;
      const mac = parts.slice(-6).map((x) => Number(x).toString(16).padStart(2, '0')).join(':');
      const ifIndex = basePortToIf.get(String(toNum(r.value)));
      const ex = neigh.get(mac);
      if (ex) { if (!ex.ifName && ifIndex) ex.ifName = ifNameOf(ifIndex); }
      else neigh.set(mac, { mac, ifName: ifIndex ? ifNameOf(ifIndex) : undefined });
    }
    const neighbors = [...neigh.values()].slice(0, 250);

    return { snapshot: { uptimeSec, deviceMac, interfaces, neighbors }, state: { ts: now, counters } };
  } finally {
    try { session.close(); } catch { /* already closed */ }
  }
}
