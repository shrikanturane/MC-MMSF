import https from 'node:https';
import { Client } from 'ssh2';
import type { CloudAccountRef, CloudConnector, DiscoveredAsset, ProviderCredentials, TestResult } from './adapter';
import { runStages } from './adapter';

// ── Shared HTTPS (self-signed certs are the norm for on-prem hypervisors) ────────────
interface HttpResp { status: number; body: string; json: any }
function httpsReq(o: { host: string; port: number; path: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<HttpResp> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: o.host, port: o.port, path: o.path, method: o.method ?? 'GET', headers: o.headers ?? {}, rejectUnauthorized: false, timeout: o.timeoutMs ?? 15000 },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => { let j: any = null; try { j = JSON.parse(data); } catch { /* non-JSON */ } resolve({ status: res.statusCode ?? 0, body: data, json: j }); });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('connection timed out')));
    if (o.body) req.write(o.body);
    req.end();
  });
}
const basicAuth = (u?: string, p?: string) => 'Basic ' + Buffer.from(`${u ?? ''}:${p ?? ''}`).toString('base64');

// ── VMware vSphere (vCenter, or ESXi 7+ which exposes the same REST API) ──────────────
export class VmwareConnector implements CloudConnector {
  constructor(readonly provider = 'vmware') {}
  private port(c: ProviderCredentials) { return Number(c.port) || 443; }

  /** vSphere 7/8: POST /api/session ; 6.x: POST /rest/com/vmware/cis/session. Returns a session id. */
  private async session(c: ProviderCredentials): Promise<string> {
    const host = String(c.host), port = this.port(c);
    let r = await httpsReq({ host, port, path: '/api/session', method: 'POST', headers: { Authorization: basicAuth(c.username, c.password) } });
    if (r.status === 200 || r.status === 201) return (typeof r.json === 'string' ? r.json : String(r.body)).replace(/"/g, '');
    r = await httpsReq({ host, port, path: '/rest/com/vmware/cis/session', method: 'POST', headers: { Authorization: basicAuth(c.username, c.password) } });
    if ((r.status === 200 || r.status === 201) && r.json?.value) return r.json.value;
    throw new Error(`vSphere login failed (HTTP ${r.status})${r.status === 401 ? ' — check username/password' : ''}`);
  }
  private async vmList(c: ProviderCredentials, sid: string): Promise<any[]> {
    const host = String(c.host), port = this.port(c);
    let r = await httpsReq({ host, port, path: '/api/vcenter/vm', headers: { 'vmware-api-session-id': sid } });
    if (r.status === 200 && Array.isArray(r.json)) return r.json;
    r = await httpsReq({ host, port, path: '/rest/vcenter/vm', headers: { 'vmware-api-session-id': sid } });
    if (r.status === 200 && Array.isArray(r.json?.value)) return r.json.value;
    throw new Error(`could not list VMs (HTTP ${r.status})`);
  }
  async test(c: ProviderCredentials): Promise<TestResult> {
    return runStages([
      { name: 'Validate inputs', run: async () => { if (!c.host || !c.username || !c.password) throw new Error('host, username and password are required'); return `${c.username}@${c.host}:${this.port(c)}`; } },
      { name: 'Authenticate (vSphere REST session)', run: async () => { await this.session(c); return 'session created'; } },
      { name: 'List virtual machines', run: async () => { const s = await this.session(c); return `${(await this.vmList(c, s)).length} VM(s) visible`; } },
    ]);
  }
  async discover(_a: CloudAccountRef, c: ProviderCredentials): Promise<DiscoveredAsset[]> {
    const sid = await this.session(c);
    return (await this.vmList(c, sid)).map((v) => ({
      resourceType: 'vm', externalId: `${this.provider}:${v.vm}`, name: v.name ?? v.vm, region: String(c.host), cpuPct: 0, memoryPct: 0,
      properties: { discoveredBy: 'vmware-connector', hypervisor: this.provider, state: String(v.power_state || '').toLowerCase() === 'powered_on' ? 'running' : 'stopped', cpus: v.cpu_count, memoryMb: v.memory_size_MiB, os: v.guest_OS },
    }));
  }
}

// ── Nutanix Prism (Central/Element) v3 REST ──────────────────────────────────────────
export class NutanixConnector implements CloudConnector {
  readonly provider = 'nutanix';
  private port(c: ProviderCredentials) { return Number(c.port) || 9440; }
  private async vmsList(c: ProviderCredentials, length = 500): Promise<any[]> {
    const r = await httpsReq({ host: String(c.host), port: this.port(c), path: '/api/nutanix/v3/vms/list', method: 'POST', headers: { Authorization: basicAuth(c.username, c.password), 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'vm', length }) });
    if (r.status === 200 && Array.isArray(r.json?.entities)) return r.json.entities;
    if (r.status === 401) throw new Error('Prism login failed (HTTP 401) — check username/password');
    throw new Error(`Prism vms/list failed (HTTP ${r.status})`);
  }
  async test(c: ProviderCredentials): Promise<TestResult> {
    return runStages([
      { name: 'Validate inputs', run: async () => { if (!c.host || !c.username || !c.password) throw new Error('host, username and password are required'); return `${c.username}@${c.host}:${this.port(c)}`; } },
      { name: 'Authenticate + list VMs (Prism v3)', run: async () => { await this.vmsList(c, 1); return 'Prism reachable'; } },
    ]);
  }
  async discover(_a: CloudAccountRef, c: ProviderCredentials): Promise<DiscoveredAsset[]> {
    return (await this.vmsList(c, 500)).map((e) => {
      const s = e.status || {}, res = s.resources || (e.spec?.resources) || {};
      return {
        resourceType: 'vm', externalId: `nutanix:${e.metadata?.uuid}`, name: s.name || e.spec?.name || e.metadata?.uuid, region: String(c.host), cpuPct: 0, memoryPct: 0,
        properties: { discoveredBy: 'nutanix-connector', hypervisor: 'nutanix', state: String(res.power_state || '').toLowerCase() === 'on' ? 'running' : 'stopped', cpus: (res.num_sockets || 1) * (res.num_vcpus_per_socket || 1), memoryMb: res.memory_size_mib },
      };
    });
  }
}

// ── Proxmox VE REST (ticket auth) ────────────────────────────────────────────────────
export class ProxmoxConnector implements CloudConnector {
  readonly provider = 'proxmox';
  private port(c: ProviderCredentials) { return Number(c.port) || 8006; }
  private async ticket(c: ProviderCredentials): Promise<string> {
    const body = `username=${encodeURIComponent(c.username || '')}&password=${encodeURIComponent(c.password || '')}`;
    const r = await httpsReq({ host: String(c.host), port: this.port(c), path: '/api2/json/access/ticket', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)) }, body });
    if (r.status === 200 && r.json?.data?.ticket) return r.json.data.ticket;
    throw new Error(`Proxmox auth failed (HTTP ${r.status}) — the username must include a realm, e.g. root@pam`);
  }
  private get(c: ProviderCredentials, path: string, ticket: string) {
    return httpsReq({ host: String(c.host), port: this.port(c), path, headers: { Cookie: `PVEAuthCookie=${ticket}` } });
  }
  async test(c: ProviderCredentials): Promise<TestResult> {
    return runStages([
      { name: 'Validate inputs', run: async () => { if (!c.host || !c.username || !c.password) throw new Error('host, username (user@realm) and password are required'); return `${c.username}@${c.host}:${this.port(c)}`; } },
      { name: 'Authenticate (ticket)', run: async () => { await this.ticket(c); return 'ticket issued'; } },
      { name: 'List nodes', run: async () => { const t = await this.ticket(c); const r = await this.get(c, '/api2/json/nodes', t); if (r.status !== 200) throw new Error(`/nodes HTTP ${r.status}`); return `${(r.json?.data || []).length} node(s)`; } },
    ]);
  }
  async discover(_a: CloudAccountRef, c: ProviderCredentials): Promise<DiscoveredAsset[]> {
    const t = await this.ticket(c);
    const nodes = (await this.get(c, '/api2/json/nodes', t)).json?.data || [];
    const out: DiscoveredAsset[] = [];
    for (const n of nodes) {
      const node = n.node;
      const q = await this.get(c, `/api2/json/nodes/${node}/qemu`, t);
      for (const vm of (q.json?.data || [])) {
        out.push({
          resourceType: 'vm', externalId: `proxmox:${node}/${vm.vmid}`, name: vm.name || `vm-${vm.vmid}`, region: String(c.host),
          cpuPct: vm.cpu ? Math.round(vm.cpu * 1000) / 10 : 0, memoryPct: vm.mem && vm.maxmem ? Math.round((vm.mem / vm.maxmem) * 1000) / 10 : 0,
          properties: { discoveredBy: 'proxmox-connector', hypervisor: 'proxmox', node, state: vm.status === 'running' ? 'running' : 'stopped', cpus: vm.cpus, memoryMb: vm.maxmem ? Math.round(vm.maxmem / 1048576) : undefined },
        });
      }
    }
    return out;
  }
}

// ── KVM / libvirt over SSH (virsh) ───────────────────────────────────────────────────
export class KvmConnector implements CloudConnector {
  readonly provider = 'kvm';
  private exec(c: ProviderCredentials, command: string): Promise<string> {
    const conn = new Client();
    return new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => { conn.end(); reject(new Error('ssh timeout')); }, 20000);
      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) { clearTimeout(timer); conn.end(); return reject(err); }
          stream.on('data', (d: Buffer) => (out += d.toString())).on('close', () => { clearTimeout(timer); conn.end(); resolve(out); });
          stream.stderr.on('data', () => undefined);
        });
      }).on('error', (err) => { clearTimeout(timer); reject(err); }).connect({
        host: c.host, port: c.port ? Number(c.port) : 22, username: c.username,
        ...(c.password ? { password: c.password } : {}), ...(c.privateKey ? { privateKey: c.privateKey } : {}), readyTimeout: 12000,
      });
    });
  }
  async test(c: ProviderCredentials): Promise<TestResult> {
    return runStages([
      { name: 'Validate inputs', run: async () => { if (!c.host || !c.username) throw new Error('host and username are required'); if (!c.password && !c.privateKey) throw new Error('a password or private key is required'); return `${c.username}@${c.host}:${c.port || 22}`; } },
      { name: 'SSH + libvirt (virsh)', run: async () => { const o = await this.exec(c, 'virsh version 2>/dev/null || sudo -n virsh version 2>/dev/null'); if (!/library|Compiled|Using/i.test(o)) throw new Error('virsh not available — install libvirt-clients and ensure the user can reach libvirtd (libvirt group or sudo)'); return (o.split('\n').find((l) => /library/i.test(l)) || 'libvirt OK').trim(); } },
    ]);
  }
  async discover(_a: CloudAccountRef, c: ProviderCredentials): Promise<DiscoveredAsset[]> {
    const out = await this.exec(c, 'virsh list --all 2>/dev/null || sudo -n virsh list --all 2>/dev/null');
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const start = lines.findIndex((l) => /^-{3,}/.test(l));
    const rows = start >= 0 ? lines.slice(start + 1) : lines.filter((l) => !/^Id\s+Name\s+State/i.test(l));
    return rows.map((l) => {
      const m = l.match(/^(\S+)\s+(\S+)\s+(.+)$/);
      if (!m) return null;
      const [, , name, state] = m;
      return {
        resourceType: 'vm', externalId: `kvm:${String(c.host)}/${name}`, name, region: String(c.host), cpuPct: 0, memoryPct: 0,
        properties: { discoveredBy: 'kvm-connector', hypervisor: 'kvm', state: /running/i.test(state) ? 'running' : 'stopped' },
      } as DiscoveredAsset;
    }).filter(Boolean) as DiscoveredAsset[];
  }
}
