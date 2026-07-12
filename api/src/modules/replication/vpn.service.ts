import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { sshRun } from '../database/ssh-deploy';
import { decryptJson, encryptJson } from '../../connectors/crypto';
import { getConnector } from '../../connectors/factory';
import { vpnProfile, CLOUD_REQS, VPN_PROFILES } from './vpn-profiles';

/**
 * Cross-cloud VPN links via IPsec (strongSwan / swanctl). MCMF is the control + status plane: it brokers
 * a pre-shared key, writes a symmetric swanctl connection on each peer over SSH (vault creds), brings the
 * tunnel up, and reports the SA state. When side B is an external gateway (bManual) MCMF configures only
 * side A and prints what to mirror on the far gateway. Cloud route-tables / security-groups are the
 * operator's job (MCMF can't edit a VPC route table from inside a guest).
 */
@Injectable()
export class VpnService implements OnModuleInit {
  private readonly log = new Logger('Vpn');
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Re-check monitor-only links every 60s so the card reflects live tunnel state.
    setInterval(() => this.monitorTick().catch((e) => this.log.warn(`monitorTick: ${String((e as Error)?.message ?? e)}`)), 60_000);
  }
  private async monitorTick() {
    const links = await (this.prisma as any).vpnLink.findMany({ where: { enabled: true, manage: 'monitor' } }).catch(() => []);
    for (const l of links) { if (l.monitorHost || l.vpnConnId) await this.monitor(l.id).catch(() => undefined); }
  }

  private async sshCred(host: string): Promise<{ username: string; password: string; port: number } | null> {
    if (!host) return null;
    const c = await this.prisma.vmCredential.findFirst({ where: { host, protocol: 'ssh' } });
    if (!c) return null;
    let password = '';
    try { password = decryptJson<string>(c.password); } catch { /* key-auth */ }
    return { username: c.username, password, port: 22 };
  }
  private hostOf(r: any): string {
    const p = (r?.properties ?? {}) as any;
    return p.publicIp || p.ip || p.privateIp || p.ipAddress || r?.name || '';
  }
  private connName(id: string) { return 'mcmf-' + String(id).replace(/[^a-zA-Z0-9]/g, '').slice(-10); }
  private providerOf(r: any): string { return String(r?.provider || '').toLowerCase() || 'private'; }
  /** Best-effort local subnet (CIDR) from discovery metadata, else derive a /24 from the private IP. */
  private subnetOf(r: any): string {
    const p = (r?.properties ?? {}) as any;
    const cidr = p.subnetCidr || p.cidr || p.vpcCidr || p.addressPrefix || (Array.isArray(p.subnets) && p.subnets[0]?.cidr) || '';
    if (cidr && /\//.test(String(cidr))) return String(cidr);
    const ip = p.privateIp || p.ip || '';
    const m = String(ip).match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
    return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : '';
  }

  async list() {
    const links = await (this.prisma as any).vpnLink.findMany({ orderBy: { createdAt: 'desc' } }).catch(() => []);
    return links.map((l: any) => ({
      id: l.id, name: l.name, tech: l.tech, manage: l.manage, mode: l.mode, ikeVersion: l.ikeVersion, peerType: l.peerType,
      aManual: l.aManual, aId: l.aId, aName: l.aName, aProvider: l.aProvider, aHost: l.aHost, aSubnet: l.aSubnet,
      bManual: l.bManual, bId: l.bId, bName: l.bName, bProvider: l.bProvider, bDevice: l.bDevice, bHost: l.bHost, bSubnet: l.bSubnet,
      status: l.status, lastError: l.lastError, lastStatus: l.lastStatus,
      vpnConnId: l.vpnConnId, statusSource: l.statusSource, monitorHost: l.monitorHost, monitorTarget: l.monitorTarget, monitorPorts: l.monitorPorts,
      monitorUp: l.monitorUp, monitorResult: l.monitorResult, lastMonitorAt: l.lastMonitorAt?.toISOString() ?? null,
      lastCheckAt: l.lastCheckAt?.toISOString() ?? null, enabled: l.enabled,
      hasPsk: !!l.psk,
    }));
  }

  /** Running VMs that have an SSH credential in the Vault — the endpoints MCMF can genuinely reach. */
  async eligibleHosts() {
    const vms = await this.prisma.resource.findMany({ where: { type: 'compute' }, select: { id: true, name: true, provider: true, status: true, properties: true } });
    const creds = await this.prisma.vmCredential.findMany({ where: { protocol: 'ssh' }, select: { host: true } }).catch(() => []);
    const credHosts = new Set(creds.map((c) => c.host));
    const candHosts = (v: any) => { const p = (v?.properties ?? {}) as any; return [p.publicIp, p.privateIp, p.ip, p.ipAddress, ...(Array.isArray(p.ips) ? p.ips : []), v.name].filter(Boolean); };
    return vms.filter((v) => v.status === 'running').map((v) => {
      const match = candHosts(v).find((h: string) => credHosts.has(h)) || '';
      const p = (v.properties ?? {}) as any;
      return { id: v.id, name: v.name, provider: String(v.provider).toLowerCase(), os: /windows/i.test(String(p.os || '')) ? 'windows' : 'linux', host: this.hostOf(v), credHost: match, hasCred: !!match };
    }).filter((v) => v.hasCred);
  }

  /** List of supported remote gateway types (for the create form dropdown). */
  gatewayTypes() {
    return Object.values(VPN_PROFILES).map((p) => ({ key: p.key, label: p.label, cloud: !!p.cloud }));
  }

  /**
   * Auto-populate: given the chosen side-A VM (+ optional side-B VM or manual gateway type), return the
   * detected providers, auto-filled subnets, the vendor-compatible IKE/ESP proposals, the firewall ports,
   * and the requirement checklists for BOTH ends. Powers the create form before anything is written.
   */
  async requirements(body: any) {
    const aManual = !!body.aManual, bManual = !!body.bManual;
    const okProv = (p: string) => (['aws', 'azure', 'gcp', 'onprem', 'private'].includes(p) ? p : 'onprem');
    const ids = [!aManual ? body.aId : null, !bManual ? body.bId : null].filter(Boolean);
    const res = await this.prisma.resource.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, provider: true, properties: true } });
    const byId = new Map(res.map((r) => [r.id, r]));
    const a = aManual ? null : byId.get(body.aId);
    const b = bManual ? null : byId.get(body.bId);
    const aProvider = aManual ? okProv(body.aProvider) : (a ? this.providerOf(a) : '');
    const bProvider = bManual ? okProv(body.bProvider) : (b ? this.providerOf(b) : '');
    // peer type: for a cloud VM side-B, its cloud IS the gateway type; for manual, the chosen device type.
    const peerType = bManual ? (VPN_PROFILES[body.peerType] ? body.peerType : 'generic') : (bProvider && VPN_PROFILES[bProvider] ? bProvider : 'strongswan');
    const prof = vpnProfile(peerType);
    return {
      aProvider, bProvider, peerType, profileLabel: prof.label,
      aHost: a ? this.hostOf(a) : '', bHost: bManual ? String(body.bHost || '') : (b ? this.hostOf(b) : ''),
      aSubnet: a ? this.subnetOf(a) : '', bSubnet: b ? this.subnetOf(b) : '',
      ike: prof.ike, esp: prof.esp, ports: prof.ports,
      // requirements: side A's own cloud openings + the remote gateway's setup checklist
      aReqs: CLOUD_REQS[aProvider] || CLOUD_REQS.private,
      bReqs: bManual ? prof.reqs : (CLOUD_REQS[bProvider] || prof.reqs),
      peerReqs: prof.reqs, mirror: prof.mirror,
    };
  }

  async create(body: any) {
    const aManual = !!body.aManual; // side A is an external gateway (no VM)
    const bManual = !!body.bManual;
    const ids = [!aManual ? body.aId : null, !bManual ? body.bId : null].filter(Boolean);
    const res = await this.prisma.resource.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, provider: true, properties: true } });
    const byId = new Map(res.map((r) => [r.id, r]));
    const a = aManual ? null : byId.get(body.aId);
    const b = bManual ? null : byId.get(body.bId);
    if (!aManual && !a) throw new BadRequestException('Pick side-A VM, or mark side A an external gateway.');
    if (!bManual && !b) throw new BadRequestException('Pick side-B VM, or mark side B an external gateway.');
    const mode = body.mode === 'host-to-host' ? 'host-to-host' : 'site-to-site';
    const okProv = (p: string) => (['aws', 'azure', 'gcp', 'onprem', 'private'].includes(p) ? p : 'onprem');
    const aHost = aManual ? String(body.aHost || '').trim() : this.hostOf(a);
    const bHost = bManual ? String(body.bHost || '').trim() : this.hostOf(b);
    if (!aHost) throw new BadRequestException('Side-A host/gateway IP is required.');
    if (!bHost) throw new BadRequestException('Side-B host/gateway IP is required.');
    const aProvider = aManual ? okProv(body.aProvider) : this.providerOf(a);
    const bProvider = bManual ? okProv(body.bProvider) : this.providerOf(b);
    const peerType = bManual ? (VPN_PROFILES[body.peerType] ? body.peerType : 'generic') : (VPN_PROFILES[bProvider] ? bProvider : 'strongswan');
    const prof = vpnProfile(peerType);
    // When side A is an external gateway, MCMF has nothing to configure -> monitor-only (gateway↔gateway).
    const manage = aManual ? 'monitor' : 'auto';
    const aSubnet = mode === 'host-to-host' ? `${aHost}/32` : (String(body.aSubnet || '').trim() || (a ? this.subnetOf(a) : ''));
    const bSubnet = mode === 'host-to-host' ? `${bHost}/32` : (String(body.bSubnet || '').trim() || (b ? this.subnetOf(b) : ''));
    if (mode === 'site-to-site' && (!aSubnet || !bSubnet)) throw new BadRequestException('Site-to-site needs both local and remote subnets (CIDR).');
    const psk = String(body.psk || '').trim() || randomBytes(24).toString('base64');
    return (this.prisma as any).vpnLink.create({
      data: {
        name: String(body.name || 'vpn-link').slice(0, 80),
        tech: 'ipsec', manage, mode, ikeVersion: body.ikeVersion === 'ikev1' ? 'ikev1' : 'ikev2',
        peerType, ikeProposal: prof.ike, espProposal: prof.esp,
        aManual, aId: a?.id ?? '', aName: a?.name ?? (aManual ? (String(body.aDevice || `${aProvider} gateway`)) : ''), aProvider, aHost, aSubnet,
        bManual, bId: b?.id ?? '', bName: b?.name ?? (bManual ? (String(body.bDevice || `${bProvider} gateway`)) : ''), bProvider, bDevice: String(body.bDevice || '').slice(0, 80), bHost, bSubnet,
        vpnConnId: String(body.vpnConnId || '').slice(0, 80),
        monitorHost: String(body.monitorHost || '').slice(0, 64),
        monitorTarget: String(body.monitorTarget || '').slice(0, 64),
        monitorPorts: String(body.monitorPorts || '').slice(0, 200),
        psk: encryptJson(psk),
      },
    });
  }

  async update(id: string, body: any) {
    const data: any = {};
    for (const k of ['name', 'aSubnet', 'bSubnet', 'bHost'] as const) if (body[k] !== undefined) data[k] = String(body[k]).slice(0, 120);
    if (body.enabled !== undefined) data.enabled = !!body.enabled;
    if (body.psk) data.psk = encryptJson(String(body.psk));
    return (this.prisma as any).vpnLink.update({ where: { id }, data });
  }

  async remove(id: string) {
    const l = await (this.prisma as any).vpnLink.findUnique({ where: { id } }).catch(() => null);
    if (l) await this.down(id).catch(() => undefined); // best-effort teardown on the hosts
    await (this.prisma as any).vpnLink.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }

  /** swanctl config for ONE peer (local vs remote swapped per side). Proposals come from the vendor preset. */
  private swanctlConf(conn: string, selfIp: string, peerIp: string, selfTs: string, peerTs: string, ver: string, psk: string, ikeProp: string, espProp: string): string {
    const version = ver === 'ikev1' ? '1' : '2';
    const q = (s: string) => s.replace(/"/g, '');
    const ike = (ikeProp || 'aes256-sha256-modp2048') + ',default';
    const esp = (espProp || 'aes256-sha256-modp2048') + ',default';
    return [
      'connections {',
      `  ${conn} {`,
      `    version = ${version}`,
      // Cloud VMs sit behind 1:1 NAT — the PUBLIC IP isn't on the interface, so binding local_addrs to it
      // fails. Bind to any local interface (%any) and let NAT-T carry it; the public IP stays the IKE id below.
      `    local_addrs = %any`,
      `    remote_addrs = ${peerIp}`,
      `    proposals = ${ike}`,
      // strongSwan config reads a value to end-of-line — inline `{ auth = psk; id = … }` makes auth's value
      // "psk; id = …" ("invalid value for: auth"). Each setting MUST be on its own line inside the block.
      '    local {',
      '      auth = psk',
      `      id = ${selfIp}`,
      '    }',
      '    remote {',
      '      auth = psk',
      `      id = ${peerIp}`,
      '    }',
      '    children {',
      `      ${conn} {`,
      `        local_ts = ${selfTs}`,
      `        remote_ts = ${peerTs}`,
      `        esp_proposals = ${esp}`,
      '        start_action = trap',
      '        dpd_action = restart',
      '        mode = tunnel',
      '      }',
      '    }',
      '  }',
      '}',
      'secrets {',
      `  ike-${conn} {`,
      `    id-1 = ${selfIp}`,
      `    id-2 = ${peerIp}`,
      `    secret = "${q(psk)}"`,
      '  }',
      '}',
      '',
    ].join('\n');
  }

  /** Provision strongSwan on one host: install, write conf, enable ip_forward, load, (optionally) initiate. */
  private async provisionHost(host: string, conn: string, conf: string, siteToSite: boolean, initiate: boolean): Promise<string> {
    const cred = await this.sshCred(host);
    if (!cred) throw new Error(`No SSH credential for ${host} — add it in Credential Vault.`);
    const b64 = Buffer.from(conf).toString('base64');
    // Cloud VMs log in as a sudoer (ubuntu/ec2-user/…), not root — prefix privileged steps with sudo when
    // not already root. `$S env VAR=…` form so the env var survives sudo (sudo VAR=… treats VAR as a command).
    const S = `S=''; [ "$(id -u)" != "0" ] && S='sudo'; `;
    const fwd = siteToSite ? `$S sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1; grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' | $S tee -a /etc/sysctl.conf >/dev/null; ` : '';
    const cmd =
      S +
      `command -v swanctl >/dev/null 2>&1 || { ` +
      `  if command -v apt-get >/dev/null 2>&1; then $S apt-get update -y >/dev/null 2>&1; $S env DEBIAN_FRONTEND=noninteractive apt-get install -y strongswan strongswan-swanctl >/dev/null 2>&1; ` +
      `  elif command -v dnf >/dev/null 2>&1; then $S dnf install -y strongswan >/dev/null 2>&1; ` +
      `  elif command -v yum >/dev/null 2>&1; then $S yum install -y strongswan >/dev/null 2>&1; fi; }; ` +
      `command -v swanctl >/dev/null 2>&1 || { echo MCMF_NO_SWANCTL; exit 11; }; ` +
      `${fwd}` +
      `$S mkdir -p /etc/swanctl/conf.d; echo ${b64} | base64 -d | $S tee /etc/swanctl/conf.d/${conn}.conf >/dev/null; $S chmod 600 /etc/swanctl/conf.d/${conn}.conf; ` +
      `grep -q 'include conf.d' /etc/swanctl/swanctl.conf 2>/dev/null || echo 'include conf.d/*.conf' | $S tee -a /etc/swanctl/swanctl.conf >/dev/null; ` +
      `$S systemctl enable --now strongswan-swanctl >/dev/null 2>&1 || $S systemctl enable --now strongswan >/dev/null 2>&1 || $S ipsec start >/dev/null 2>&1 || true; ` +
      `$S swanctl --load-all >/dev/null 2>&1 || true; ` +
      `${initiate ? `$S swanctl --initiate --child ${conn} >/dev/null 2>&1 || true; ` : ''}` +
      `sleep 2; $S swanctl --list-sas 2>/dev/null | head -20; echo MCMF_VPN_DONE`;
    const r = await sshRun(host, cred.port, cred.username, cred.password, cmd, 180_000);
    const out = (r.stdout || '').trim();
    if (/MCMF_NO_SWANCTL/.test(out)) throw new Error(`strongSwan (swanctl) could not be installed on ${host} — install 'strongswan' + 'strongswan-swanctl' and retry.`);
    if (!/MCMF_VPN_DONE/.test(out)) throw new Error(`Configuration did not complete on ${host}: ${out.slice(0, 300)}`);
    return out;
  }

  /** Bring the link up: configure both peers (or just A if B is an external gateway) and initiate from A. */
  async up(id: string) {
    const l = await (this.prisma as any).vpnLink.findUnique({ where: { id } }).catch(() => null);
    if (!l) throw new BadRequestException('VPN link not found');
    // monitor-only (gateway↔gateway): MCMF configures nothing — you built the tunnel; we just check it.
    if (l.manage === 'monitor') return this.monitor(id);
    const conn = this.connName(l.id);
    let psk = ''; try { psk = l.psk ? decryptJson<string>(l.psk) : ''; } catch { /* */ }
    if (!psk) throw new BadRequestException('This link has no PSK.');
    const siteToSite = l.mode === 'site-to-site';
    let summary = '';
    try {
      // side A (MCMF-managed): local = A, remote = B
      const confA = this.swanctlConf(conn, l.aHost, l.bHost, l.aSubnet, l.bSubnet, l.ikeVersion, psk, l.ikeProposal, l.espProposal);
      summary = await this.provisionHost(l.aHost, conn, confA, siteToSite, true);
      if (!l.bManual) {
        // side B (MCMF-managed): local = B, remote = A (mirrored)
        const confB = this.swanctlConf(conn, l.bHost, l.aHost, l.bSubnet, l.aSubnet, l.ikeVersion, psk, l.ikeProposal, l.espProposal);
        await this.provisionHost(l.bHost, conn, confB, siteToSite, false);
      }
      const up = /ESTABLISHED|INSTALLED/.test(summary);
      await (this.prisma as any).vpnLink.update({ where: { id }, data: { status: up ? 'up' : 'down', lastError: '', lastStatus: summary.slice(0, 1500), lastCheckAt: new Date() } });
      const hint = l.bManual ? this.manualPeerHint(l, conn, psk) : undefined;
      return { ok: true, status: up ? 'up' : 'down', summary, hint };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 800);
      await (this.prisma as any).vpnLink.update({ where: { id }, data: { status: 'error', lastError: msg, lastCheckAt: new Date() } }).catch(() => undefined);
      throw new BadRequestException(msg);
    }
  }

  /** Tear the tunnel down on the managed peer(s) and remove the config. */
  async down(id: string) {
    const l = await (this.prisma as any).vpnLink.findUnique({ where: { id } }).catch(() => null);
    if (!l) throw new BadRequestException('VPN link not found');
    const conn = this.connName(l.id);
    const kill = `S=''; [ "$(id -u)" != "0" ] && S='sudo'; $S swanctl --terminate --ike ${conn} >/dev/null 2>&1 || true; $S rm -f /etc/swanctl/conf.d/${conn}.conf; $S swanctl --load-all >/dev/null 2>&1 || true; echo MCMF_VPN_DOWN`;
    for (const host of [l.aHost, l.bManual ? '' : l.bHost].filter(Boolean)) {
      const cred = await this.sshCred(host);
      if (cred) await sshRun(host, cred.port, cred.username, cred.password, kill, 60_000).catch(() => undefined);
    }
    await (this.prisma as any).vpnLink.update({ where: { id }, data: { status: 'down', lastCheckAt: new Date() } }).catch(() => undefined);
    return { ok: true, status: 'down' };
  }

  /** Refresh SA status from side A. */
  async status(id: string) {
    const l = await (this.prisma as any).vpnLink.findUnique({ where: { id } }).catch(() => null);
    if (!l) throw new BadRequestException('VPN link not found');
    const cred = await this.sshCred(l.aHost);
    if (!cred) throw new BadRequestException(`No SSH credential for ${l.aHost}.`);
    const conn = this.connName(l.id);
    const r = await sshRun(l.aHost, cred.port, cred.username, cred.password, `S=''; [ "$(id -u)" != "0" ] && S='sudo'; $S swanctl --list-sas --ike ${conn} 2>/dev/null | head -30; echo MCMF_END`, 30_000).catch(() => ({ stdout: '' }));
    const out = (r.stdout || '').trim();
    const up = /ESTABLISHED|INSTALLED/.test(out);
    await (this.prisma as any).vpnLink.update({ where: { id }, data: { status: up ? 'up' : 'down', lastStatus: out.slice(0, 1500), lastCheckAt: new Date() } }).catch(() => undefined);
    return { ok: true, status: up ? 'up' : 'down', summary: out };
  }

  /**
   * Monitor a link's site-to-site state + which ports are open. Authoritative cloud-API status first
   * (AWS DescribeVpnConnections / Azure connection status / GCP vpnTunnel status, when a vpnConnId +
   * connected account exist), else an active probe from an SSH-reachable host near one tunnel end.
   */
  async monitor(id: string) {
    const l = await (this.prisma as any).vpnLink.findUnique({ where: { id } }).catch(() => null);
    if (!l) throw new BadRequestException('VPN link not found');
    // 1) cloud-API (authoritative for cloud-native gateways) — AWS / Azure / GCP
    if (l.vpnConnId) {
      const api = await this.cloudVpnStatus(l).catch(() => null);
      if (api) {
        const src = `${api.provider}-api`;
        const detail = `${api.provider.toUpperCase()} ${l.vpnConnId} — state=${api.state}\n` + api.tunnels.map((t: any) => `  ${t.ip || 'tunnel'}: ${t.status}${t.msg ? ` (${t.msg})` : ''}`).join('\n');
        await (this.prisma as any).vpnLink.update({ where: { id }, data: { status: api.up ? 'up' : 'down', monitorUp: api.up, monitorResult: detail.slice(0, 1500), statusSource: src, lastMonitorAt: new Date(), lastCheckAt: new Date(), lastError: '' } });
        return { ok: true, status: api.up ? 'up' : 'down', source: src, detail };
      }
    }
    // 2) active probe from a reachable host
    try {
      const probe = await this.probeTunnel(l);
      await (this.prisma as any).vpnLink.update({ where: { id }, data: { status: probe.up ? 'up' : 'down', monitorUp: probe.up, monitorResult: probe.detail.slice(0, 1500), statusSource: 'probe', lastMonitorAt: new Date(), lastCheckAt: new Date(), lastError: '' } });
      return { ok: true, status: probe.up ? 'up' : 'down', source: 'probe', detail: probe.detail };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 400);
      await (this.prisma as any).vpnLink.update({ where: { id }, data: { status: 'error', lastError: msg, lastCheckAt: new Date() } }).catch(() => undefined);
      throw new BadRequestException(msg);
    }
  }

  /** Authoritative tunnel status via the cloud provider's API (best-effort; null if unavailable). */
  private async cloudVpnStatus(l: any): Promise<{ up: boolean; state: string; tunnels: any[]; provider: string } | null> {
    // pick the cloud to query: prefer the gateway (external) side, then any cloud side.
    const clouds = ['aws', 'azure', 'gcp'];
    const provider = (l.aManual && clouds.includes(l.aProvider) && l.aProvider)
      || (l.bManual && clouds.includes(l.bProvider) && l.bProvider)
      || (clouds.includes(l.aProvider) && l.aProvider)
      || (clouds.includes(l.bProvider) && l.bProvider) || '';
    if (!provider) return null;
    const cc = await this.prisma.cloudConnection.findFirst({ where: { provider: provider as any } }).catch(() => null);
    if (!cc?.credentials) return null;
    let creds: any; try { creds = decryptJson(cc.credentials); } catch { return null; }
    const conn = getConnector(provider) as any;
    if (typeof conn.vpnConnectionStatus !== 'function') return null;
    const r = await conn.vpnConnectionStatus(creds, l.vpnConnId);
    return { ...r, provider };
  }

  /** Determine an SSH-reachable probe host + its OS, ping the far target, and TCP-test the ports. */
  private async probeTunnel(l: any): Promise<{ up: boolean; detail: string }> {
    const target = String(l.monitorTarget || '').trim();
    if (!target) throw new Error('Set a "target IP" on the far side (an address reachable THROUGH the tunnel) to monitor.');
    // pick the probe host: explicit monitorHost, else a VM side of the link that has SSH creds.
    let from = String(l.monitorHost || '').trim();
    if (!from) { for (const h of [l.aManual ? '' : l.aHost, l.bManual ? '' : l.bHost].filter(Boolean)) { if (await this.sshCred(h)) { from = h; break; } } }
    if (!from) throw new Error('Set a "probe from" host — a VM near one tunnel end that has an SSH credential in the Vault.');
    const cred = await this.sshCred(from);
    if (!cred) throw new Error(`No SSH credential for the probe host ${from} — add it in Credential Vault.`);
    const ports = String(l.monitorPorts || '').split(/[,\s]+/).map((p: string) => p.trim()).filter((p: string) => /^\d{1,5}$/.test(p)).slice(0, 20);
    // OS of the probe host (Windows uses Test-NetConnection; Linux uses ping + /dev/tcp).
    const vms = await this.prisma.resource.findMany({ where: { type: 'compute' }, select: { properties: true, name: true } });
    const isWin = vms.some((v) => { const p = (v.properties ?? {}) as any; const hosts = [p.publicIp, p.privateIp, p.ip, ...(Array.isArray(p.ips) ? p.ips : []), v.name].filter(Boolean); return hosts.includes(from) && /windows/i.test(String(p.os || '')); });
    let cmd: string;
    if (isWin) {
      const pl = ports.map((p) => `if((Test-NetConnection ${target} -Port ${p} -WarningAction SilentlyContinue).TcpTestSucceeded){'PORT:${p}:open'}else{'PORT:${p}:closed'}`).join('; ');
      cmd = `powershell -NoProfile -Command "if(Test-Connection ${target} -Count 2 -Quiet){'PING:up'}else{'PING:down'}; ${pl}; 'MON_DONE'"`;
    } else {
      const pl = ports.map((p) => `{ timeout 3 bash -c 'echo > /dev/tcp/${target}/${p}' 2>/dev/null && echo PORT:${p}:open; } || echo PORT:${p}:closed`).join('; ');
      cmd = `ping -c2 -W2 ${target} >/dev/null 2>&1 && echo PING:up || echo PING:down; ${pl}; echo MON_DONE`;
    }
    const r = await sshRun(from, cred.port, cred.username, cred.password, cmd, 60_000);
    const out = (r.stdout || '');
    if (!/MON_DONE/.test(out)) throw new Error(`Probe did not complete on ${from}: ${out.slice(0, 200)}`);
    const pingUp = /PING:up/.test(out);
    const openPorts = [...out.matchAll(/PORT:(\d+):open/g)].map((m) => m[1]);
    const closedPorts = [...out.matchAll(/PORT:(\d+):closed/g)].map((m) => m[1]);
    const up = pingUp || openPorts.length > 0;
    const detail = `probe from ${from} → ${target}\nreachable (ping): ${pingUp ? 'yes' : 'no'}` +
      (ports.length ? `\nopen ports: ${openPorts.join(', ') || 'none'}\nclosed ports: ${closedPorts.join(', ') || 'none'}` : '');
    return { up, detail };
  }

  /** For an external-gateway (bManual) link: the mirrored config the operator applies on their gateway. */
  private manualPeerHint(l: any, conn: string, psk: string): string {
    const prof = vpnProfile(l.peerType || 'generic');
    return [
      `# Far gateway: ${prof.label} at ${l.bHost}. Local = ${l.bHost}, remote (peer) = ${l.aHost}.`,
      `# IKEv${l.ikeVersion === 'ikev1' ? '1' : '2'}, PSK auth. local_ts = ${l.bSubnet}   remote_ts = ${l.aSubnet}`,
      `# Phase-1/2 to match: ${prof.mirror.join(' | ')}`,
      `# Open: ${prof.ports.join(' · ')}`,
      ...prof.reqs.map((r: string) => `#  - ${r}`),
      `# Pre-shared key: ${psk}`,
    ].join('\n');
  }
}
