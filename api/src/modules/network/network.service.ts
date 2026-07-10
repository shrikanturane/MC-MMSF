import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptJson, encryptJson } from '../../connectors/crypto';
import { ephemeralKey } from '../console/cloud-ssh';
import { notifyApprovers } from '../../mail/notify';
import { sysParams, pInt } from '../../system-params';
import { cleanCreds } from '../../connectors/adapter';
import { getConnector } from '../../connectors/factory';
import { verifyTotp } from '../../auth/totp';
import { classifyEnvironment } from '../policies/policies.service';
import { ApprovalGate, type GateActor } from '../approvals/approval-gate.service';
import type { NetworkRule } from '../../connectors/adapter';
import { buildProvisionSchema, type ProvDynamic, type ProvSchema } from './provision-schema';
import { buildGrantScript, type GrantScript } from './grant-scripts';
import { mergeHostResources, buildMonByIp, liveHostStatus, isHostResource } from '../../common/host-identity';
import { derivePsk, buildVpnScript, VPN_RULES } from './vpn';
import * as net from 'node:net';
import { exec } from 'node:child_process';

const SENSITIVE_PORTS: Record<number, string> = {
  22: 'SSH', 3389: 'RDP', 3306: 'MySQL', 5432: 'PostgreSQL', 1433: 'MSSQL', 27017: 'MongoDB', 23: 'Telnet', 21: 'FTP', 5900: 'VNC', 6379: 'Redis', 9200: 'Elasticsearch',
};

function isPublicSource(s: string): boolean {
  const v = (s || '').trim().toLowerCase();
  return v === '0.0.0.0/0' || v === '::/0' || v === '*' || v === 'any' || v === 'internet';
}

/** Derive an Azure-ish "kind" for a network resource from its type metadata. */
function networkKind(provider: string, properties: any, type: string): string | null {
  const at = String(properties?.azureType ?? '').toLowerCase();
  if (provider === 'azure') {
    if (at.includes('/virtualnetworks')) return 'Virtual Network';
    if (at.includes('/networksecuritygroups')) return 'Security Group';
    if (at.includes('/publicipaddresses')) return 'Public IP';
    if (at.includes('/networkinterfaces')) return 'Network Interface';
    if (at.includes('/loadbalancers')) return 'Load Balancer';
    if (at.includes('/routetables')) return 'Route Table';
    if (at.includes('/natgateways')) return 'NAT Gateway';
    if (at.includes('/bastionhosts')) return 'Bastion';
    if (at.includes('/networkwatchers')) return 'Network Watcher';
    if (at.includes('microsoft.network/')) return 'Network (other)';
    return null;
  }
  return type === 'network' ? 'Network' : null;
}

@Injectable()
export class NetworkService {
  private readonly log = new Logger('Network');
  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: ApprovalGate,
  ) {}

  /** Virtual network topology: app → provider → VPC/VNet (resource-group/region) → VMs. */
  async topology() {
    const CLOUDS = new Set(['aws', 'azure', 'gcp', 'docker', 'linux', 'windows']);
    const [conns, resourcesRaw, risks, monitors] = await Promise.all([
      this.prisma.cloudConnection.findMany(),
      this.prisma.resource.findMany(),
      this.prisma.networkRisk.findMany(),
      this.prisma.monitor.findMany({ where: { enabled: true }, select: { target: true, altTargets: true, status: true } }),
    ]);
    // Collapse duplicate host identities so each machine is a single topology node (same merge as the
    // VM list). Cloud VMs / networks pass through unchanged.
    const resources = mergeHostResources(resourcesRaw);
    // Live reachability for hosts (heartbeat ≤120s OR an up monitor), so a shut-down host shows down.
    const monByIp = buildMonByIp(monitors);
    const vmStatus = (v: any) => (isHostResource(v) ? liveHostStatus(v, monByIp) : v.status);
    const providers = [...new Set([...conns.map((c) => c.provider), ...resources.map((r) => r.provider)])].filter((p) => CLOUDS.has(p));

    const out = providers.map((provider) => {
      const conn = conns.find((c) => c.provider === provider);
      const provRes = resources.filter((r) => r.provider === provider);
      const vms = provRes.filter((r) => r.type === 'compute' || provider === 'linux' || provider === 'windows' || provider === 'docker');
      const nets = provRes.filter((r) => r.type === 'network');
      const provRisks = risks.filter((r) => r.provider === provider);

      // VPN gateways (Azure virtualNetworkGateways / AWS vpn / GCP vpnTunnels).
      const vpnGateways = nets
        .filter((n) => /gateway|vpn-|vpngw|vpngateway|virtualnetworkgateway|vpntunnel/i.test(`${(n.properties as any)?.azureType ?? ''} ${n.name}`))
        .map((n) => ({ name: n.name }));

      const groupKey = (r: any) => (r.properties as any)?.resourceGroup || (r.properties as any)?.vpcId || (r.properties as any)?.vpc || r.region || 'default';
      const keys = [...new Set([...vms.map(groupKey), ...nets.map(groupKey)])];

      const networks = keys.map((key) => {
        const gvms = vms.filter((v) => groupKey(v) === key);
        const gnets = nets.filter((n) => groupKey(n) === key);
        const vnet = gnets.find((n) => /virtualnetworks|\/vpc|vnet|network$/i.test(`${(n.properties as any)?.azureType ?? ''} ${n.name}`));
        const nsgNames = gnets.filter((n) => /networksecuritygroups|securitygroup|nsg|firewall/i.test(`${(n.properties as any)?.azureType ?? ''} ${n.name}`)).map((n) => n.name);
        const openPorts = provRisks
          .filter((r) => gnets.some((n) => n.name === r.resourceName))
          .map((r) => ({ resourceName: r.resourceName, ports: r.ports, source: r.source, protocol: r.protocol, severity: r.severity }));
        return {
          id: `${provider}:${key}`,
          name: key,
          region: gvms[0]?.region ?? gnets[0]?.region ?? '',
          vnet: vnet?.name ?? null,
          nsgs: nsgNames,
          resourceCount: gnets.length,
          openPorts,
          vms: gvms.map((v) => {
            const st = vmStatus(v);
            return {
            id: v.id,
            name: v.name,
            status: st,
            up: st === 'running',
            provider: v.provider,
            region: v.region,
            publicIp: (v.properties as any)?.publicIp ?? null,
            privateIp: (v.properties as any)?.privateIp ?? null,
            controllable: ['aws', 'azure', 'gcp'].includes(v.provider),
            os: (v.properties as any)?.os ?? null,
            size: (v.properties as any)?.size ?? null,
            cpuPct: Number((v.cpuPct ?? 0).toFixed(1)),
            memoryPct: Number((v.memoryPct ?? 0).toFixed(1)),
            diskPct: Number(((v.diskPct ?? (v.properties as any)?.diskPct) ?? 0).toFixed(1)),
            };
          }),
        };
      }).filter((n) => n.vms.length > 0 || n.resourceCount > 0);

      return {
        provider,
        status: conn?.status ?? (provRes.length ? 'connected' : 'disconnected'),
        vmCount: vms.length,
        upCount: vms.filter((v) => vmStatus(v) === 'running').length,
        hasVpn: vpnGateways.length > 0,
        vpnGateways,
        networks,
      };
    });

    // Site-to-site pairs across cloud providers (detected = both ends have a VPN gateway).
    const cloudProviders = out.filter((p) => ['aws', 'azure', 'gcp'].includes(p.provider));
    const pairs: { a: string; b: string; status: string }[] = [];
    for (let i = 0; i < cloudProviders.length; i++) {
      for (let j = i + 1; j < cloudProviders.length; j++) {
        const a = cloudProviders[i];
        const b = cloudProviders[j];
        pairs.push({ a: a.provider, b: b.provider, status: a.hasVpn && b.hasVpn ? 'detected' : 'none' });
      }
    }

    return { app: { name: 'MCMF', host: process.env.SSO_BASE_URL || 'https://localhost' }, providers: out, vpnPairs: pairs, generatedAt: new Date().toISOString() };
  }

  /** Network monitoring depth: connectivity, latency (per-link + fleet), per-VM throughput. */
  async monitoring() {
    const monitors = await this.prisma.monitor.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } });
    const up = monitors.filter((m) => m.status === 'up').length;
    const down = monitors.filter((m) => m.status === 'down').length;
    const unknown = monitors.length - up - down;

    const latencies = monitors.map((m) => {
      const hist = ((m.history as any[]) ?? []).filter((h) => h && typeof h.ms === 'number');
      const msList = hist.map((h) => h.ms as number);
      const avg = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : null;
      return {
        id: m.id,
        name: m.name,
        target: m.target,
        type: m.type,
        group: m.group,
        status: m.status,
        lastLatencyMs: m.lastLatencyMs,
        avgLatencyMs: avg,
        history: ((m.history as any[]) ?? []).slice(-20).map((h) => ({ up: !!h.up, ms: typeof h.ms === 'number' ? h.ms : null })),
      };
    });
    const live = latencies.map((l) => l.lastLatencyMs).filter((x): x is number => typeof x === 'number');
    const fleetAvgLatency = live.length ? Math.round(live.reduce((a, b) => a + b, 0) / live.length) : null;

    const vms = await this.prisma.resource.findMany({ where: { type: 'compute' }, orderBy: { networkMbps: 'desc' } });
    const throughput = vms.map((v) => ({ name: v.name, provider: v.provider, networkMbps: Number((v.networkMbps ?? 0).toFixed(2)) }));
    const totalMbps = Number(throughput.reduce((s, t) => s + t.networkMbps, 0).toFixed(2));

    return {
      connectivity: { total: monitors.length, up, down, unknown, uptimePct: monitors.length ? Math.round((up / monitors.length) * 100) : 0 },
      fleetAvgLatency,
      latencies,
      throughput: throughput.slice(0, 30),
      totalMbps,
    };
  }

  /**
   * Provisioning form schema for a provider + kind, with live option pools
   * (regions / resource groups / networks) injected best-effort from the cloud.
   */
  async provisionSchema(provider: string, kind: string, region?: string, adminIp?: string): Promise<ProvSchema> {
    const p = (provider || '').toLowerCase();
    const k = ['network', 'vm', 'disk'].includes(kind) ? kind : 'network';
    const mcmfIp = (process.env.SSO_BASE_URL || 'https://localhost').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    let dyn: ProvDynamic = { mcmfIp, adminIp: (adminIp || '').replace(/^::ffff:/, '') || undefined };
    try {
      const conn = await this.prisma.cloudConnection.findFirst({ where: { provider: p as any } });
      if (conn) {
        const connector = getConnector(p);
        if (connector.listProvisionOptions) {
          const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
          dyn = { ...dyn, ...(await connector.listProvisionOptions(creds, region)) };
        }
      }
    } catch (e) {
      this.log.warn(`provision options ${p}: ${String((e as Error)?.message ?? e)}`);
    }
    return buildProvisionSchema(p, k, dyn);
  }

  /**
   * Pre-populated permission-grant scripts for every connected cloud, built from each
   * connection's stored (non-secret) identity — zero-touch: copy, run in Cloud Shell, done.
   */
  /** Masked by default: account/subscription/project/client ids are hidden until an admin reveals with 2FA. */
  async grantScripts() {
    return this.buildGrantScripts(true);
  }

  /** Reveal the real identifiers in the grant scripts — admin only, requires a fresh 2FA code (step-up). */
  async grantScriptsReveal(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.totpEnabled || !user.totpSecret) throw new BadRequestException('Enable two-factor authentication first to reveal cloud identifiers.');
    if (!verifyTotp(user.totpSecret, String(code || '').replace(/\s/g, ''))) throw new BadRequestException('Invalid 2FA code — check your authenticator and try again.');
    await this.prisma.eventLog.create({ data: { type: 'control', severity: 'warning', title: `${user.email} revealed cloud grant identifiers (2FA verified)` } }).catch(() => undefined);
    return this.buildGrantScripts(false);
  }

  /** Mask a sensitive identifier — keep the last 4 chars (or just the domain for emails). */
  private maskVal(v?: string): string {
    const s = String(v ?? '');
    if (!s) return s;
    if (s.includes('@')) { const [, d] = s.split('@'); return `••••@${d}`; }
    return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
  }
  private maskIdentity(id: any): any {
    const out: any = { ...(id ?? {}) };
    for (const k of ['account', 'subscriptionId', 'clientId', 'tenantId', 'project', 'serviceAccountEmail', 'user', 'userName']) if (out[k]) out[k] = this.maskVal(out[k]);
    return out;
  }

  private async buildGrantScripts(mask: boolean) {
    const conns = await this.prisma.cloudConnection.findMany({ where: { provider: { in: ['aws', 'azure', 'gcp'] as any } } });
    const out: Array<{ provider: string; connectionName: string; masked: boolean } & GrantScript> = [];
    for (const conn of conns) {
      const connector = getConnector(conn.provider);
      let id = {};
      try {
        if (connector.identity) {
          const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
          id = await connector.identity(creds);
        }
      } catch (e) {
        this.log.warn(`identity ${conn.provider}: ${String((e as Error)?.message ?? e)}`);
      }
      const g = buildGrantScript(conn.provider, mask ? this.maskIdentity(id) : id);
      if (mask) g.loginUrl = null; // the auto-run Cloud Shell link embeds real ids — only after reveal
      out.push({ provider: conn.provider, connectionName: conn.name, masked: mask, ...g });
    }
    return out;
  }

  /** True when BOTH clouds in the pair have a detected VPN gateway (from the topology scan). */
  async isVpnDeployed(a: string, b: string): Promise<boolean> {
    const topo = await this.topology();
    const pa = topo.providers.find((p) => p.provider === a);
    const pb = topo.providers.find((p) => p.provider === b);
    return !!(pa?.hasVpn && pb?.hasVpn);
  }

  /** Site-to-site VPN status per cloud pair: deployed?, auto PSK, required rules, deploy scripts. */
  async vpnStatus() {
    const topo = await this.topology();
    const clouds = topo.providers.filter((p) => ['aws', 'azure', 'gcp'].includes(p.provider));
    const pairs: Array<{ a: string; b: string; deployed: boolean; aHasGateway: boolean; bHasGateway: boolean; psk: string; rules: typeof VPN_RULES; scripts: ReturnType<typeof buildVpnScript>[] }> = [];
    for (let i = 0; i < clouds.length; i++) {
      for (let j = i + 1; j < clouds.length; j++) {
        const a = clouds[i];
        const b = clouds[j];
        const psk = derivePsk(a.provider, b.provider);
        pairs.push({
          a: a.provider,
          b: b.provider,
          deployed: !!(a.hasVpn && b.hasVpn),
          aHasGateway: !!a.hasVpn,
          bHasGateway: !!b.hasVpn,
          psk,
          rules: VPN_RULES,
          scripts: [buildVpnScript(a.provider, b.provider, psk), buildVpnScript(b.provider, a.provider, psk)],
        });
      }
    }
    return { pairs, generatedAt: new Date().toISOString() };
  }

  /** Reachability/port test toward a gateway endpoint (TCP connect, or ICMP ping fallback). */
  async vpnTest(host: string, port?: number): Promise<{ reachable: boolean; detail: string }> {
    const target = (host || '').trim();
    if (!target) throw new BadRequestException('enter the peer gateway IP/host to test');
    const p = port && Number(port) > 0 ? Number(port) : 4500;
    const tcp = await new Promise<boolean>((resolve) => {
      const s = new net.Socket();
      const done = (ok: boolean) => { s.destroy(); resolve(ok); };
      s.setTimeout(3000);
      s.once('connect', () => done(true));
      s.once('timeout', () => done(false));
      s.once('error', () => done(false));
      s.connect(p, target);
    });
    if (tcp) return { reachable: true, detail: `TCP ${p} reachable on ${target}.` };
    const ping = await new Promise<boolean>((resolve) => {
      const safe = target.replace(/[^a-zA-Z0-9.\-:]/g, '');
      exec(`ping -c 1 -w 2 ${safe}`, { timeout: 4000 }, (err) => resolve(!err));
    });
    return ping
      ? { reachable: true, detail: `${target} answers ICMP (IPsec uses UDP 500/4500 + ESP — confirm those are open both ways).` }
      : { reachable: false, detail: `${target} not reachable on TCP ${p} or ICMP. Open UDP 500, UDP 4500 and ESP both directions, and check the gateway is up.` };
  }

  /** Advanced cloud-integration status: connection + whether live provisioning is enabled. */
  async provisionStatus() {
    const exec = (process.env.PROVISION_EXEC ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    const masterOn = !!(org as any)?.provisioningEnabled;
    const conns = await this.prisma.cloudConnection.findMany({ where: { provider: { in: ['aws', 'azure', 'gcp'] as any } } });
    return conns.map((c) => {
      const execAllows = exec.length === 0 || exec.includes(c.provider) || exec.includes('all');
      return {
        provider: c.provider,
        connectionId: c.id,
        connectionName: c.name,
        status: c.status,
        lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
        assetsFound: c.assetsFound,
        // Live create is allowed only when the master toggle is ON (and any PROVISION_EXEC allowlist permits it).
        execEnabled: masterOn && execAllows,
      };
    });
  }

  /** Run the non-destructive provisioning readiness probe for a cloud. */
  async testProvision(provider: string) {
    const p = (provider || '').toLowerCase();
    const conn = await this.prisma.cloudConnection.findFirst({ where: { provider: p as any } });
    if (!conn) throw new BadRequestException(`no ${p} connection`);
    const connector = getConnector(p);
    if (!connector.testProvision) throw new BadRequestException(`provisioning test not supported for ${p}`);
    const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    try {
      return await connector.testProvision(creds);
    } catch (e) {
      return { ready: false, detail: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  /** Create a governed provisioning request (VM / network / disk / site-to-site VPN) → Approvals. */
  async requestProvision(actor: { sub: string; email: string }, body: any) {
    const ACTIONS: Record<string, string> = { vpn: 'vpn_request', vm: 'vm_provision', disk: 'disk_provision', network: 'network_provision' };
    const kind = ACTIONS[body?.kind] ?? 'network_provision';
    const prov = (body.provider ?? '').toUpperCase();
    let title: string;
    switch (kind) {
      case 'vpn_request':
        title = `Deploy site-to-site VPN: ${body.peerA} ↔ ${body.peerB}`;
        break;
      case 'vm_provision':
        title = `Provision ${prov} VM "${body.name}" (${body.size ?? '-'}, ${body.os ?? 'image'}${body.region ? ', ' + body.region : ''})`;
        break;
      case 'disk_provision':
        title = `Provision ${prov} disk "${body.name}" (${body.sizeGb ?? '-'} GB${body.region ? ', ' + body.region : ''})`;
        break;
      default:
        title = `Provision ${prov} network "${body.name}" (${body.cidr ?? '-'}${body.region ? ', ' + body.region : ''})`;
    }

    // Dedupe: if an identical request for the same name is already pending, return it
    // instead of creating a duplicate (so a double-click / same name can't queue twice).
    const dupeName = body?.name ?? `${body?.peerA ?? ''}-${body?.peerB ?? ''}`;
    const existing = await this.prisma.approvalRequest.findFirst({
      where: { action: kind, status: 'pending', title: { contains: `"${dupeName}"` } },
    });
    if (kind !== 'vpn_request' && existing) {
      return { ok: true, requestId: existing.id, duplicate: true };
    }

    const req = await this.prisma.approvalRequest.create({
      data: {
        action: kind,
        title,
        resourceName: body.provider ?? `${body.peerA ?? ''}-${body.peerB ?? ''}`,
        payload: body ?? {},
        requestedById: actor.sub,
        requestedByEmail: actor.email,
        expiresAt: new Date(Date.now() + pInt(await sysParams(this.prisma),'approvalExpiryDays',null,7) * 24 * 3600_000),
      },
    });
    await this.prisma.eventLog.create({ data: { type: 'control', severity: 'info', title: `Provisioning requested: ${title}`, provider: body.provider ?? undefined } }).catch(() => undefined);
    await this.notifyOtherAdmins(actor.sub, actor.email, title);
    return { ok: true, requestId: req.id };
  }

  /** File a governed approval to DELETE a VM (executed via the connector once approved). */
  async requestDeprovision(actor: { sub: string; email: string }, body: any) {
    const prov = (body.provider ?? '').toUpperCase();
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('VM name is required to delete');
    const where = (body.region || body.zone || body.resourceGroup) ? ` (${body.region || body.zone}${body.resourceGroup ? ', ' + body.resourceGroup : ''})` : '';
    const title = `Delete ${prov} VM "${name}"${where}`;
    const existing = await this.prisma.approvalRequest.findFirst({ where: { action: 'vm_delete', status: 'pending', title: { contains: `"${name}"` } } });
    if (existing) return { ok: true, requestId: existing.id, duplicate: true };
    const req = await this.prisma.approvalRequest.create({
      data: { action: 'vm_delete', title, resourceName: body.provider ?? name, payload: body ?? {}, requestedById: actor.sub, requestedByEmail: actor.email, expiresAt: new Date(Date.now() + pInt(await sysParams(this.prisma),'approvalExpiryDays',null,7) * 24 * 3600_000) },
    });
    await this.prisma.eventLog.create({ data: { type: 'control', severity: 'warning', title: `VM delete requested: ${title}`, provider: body.provider ?? undefined, resourceName: name } }).catch(() => undefined);
    await this.notifyOtherAdmins(actor.sub, actor.email, title);
    return { ok: true, requestId: req.id };
  }

  /** Email the OTHER active admins that a request awaits their approval (maker-checker intimation). */
  private async notifyOtherAdmins(requesterId: string, requesterEmail: string, title: string) {
    try {
      const admins = await this.prisma.user.findMany({ where: { role: 'admin', status: 'active', NOT: { id: requesterId } }, select: { email: true } });
      await notifyApprovers(admins.map((a) => a.email), title, requesterEmail, process.env.SSO_BASE_URL || 'https://localhost');
    } catch (e) {
      this.log.warn(`notify approvers: ${String(e)}`);
    }
  }

  /** Resolve the provision form's share choice into a sharedWith value for the vault. */
  private async resolveShare(scope?: string, users?: string): Promise<string> {
    const s = String(scope ?? 'all').toLowerCase();
    if (['owner', 'just me', 'me', 'private'].includes(s)) return '';
    if (['selected', 'users', 'some'].includes(s)) {
      const emails = String(users ?? '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!emails.length) return 'all';
      const found = await this.prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } }).catch(() => [] as { id: string }[]);
      return found.length ? JSON.stringify(found.map((u) => u.id)) : 'all';
    }
    return 'all';
  }

  /** Live execution of an approved VM delete via the cloud connector (mirrors executeProvision). */
  async executeDeprovision(p: any): Promise<string> {
    const provider = String(p.provider ?? '').toLowerCase();
    const conn = await this.prisma.cloudConnection.findFirst({ where: { provider: provider as any } });
    if (!conn) throw new BadRequestException(`no ${provider} connection`);
    const connector = getConnector(provider);
    if (!connector.deprovision) throw new BadRequestException(`live delete not implemented for ${provider}`);
    // The UI row doesn't carry zone / resource-group / instance-id — resolve them from the inventory
    // Resource so each connector has what it needs (AWS = instance id, GCP = zone, Azure = RG).
    let externalId = p.externalId, zone = p.zone, resourceGroup = p.resourceGroup, region = p.region, name = String(p.name ?? '');
    let resourceId: string | undefined = p.resourceId ? String(p.resourceId) : undefined;
    if (resourceId) {
      const r = await this.prisma.resource.findUnique({ where: { id: resourceId } }).catch(() => null);
      if (r) {
        const pr = (r.properties as any) ?? {};
        externalId = externalId || r.externalId; zone = zone || pr.zone; resourceGroup = resourceGroup || pr.resourceGroup; region = region || r.region; name = name || r.name;
      }
    }
    if (provider === 'azure' && !resourceGroup && externalId) resourceGroup = String(externalId).match(/resourceGroups\/([^/]+)/i)?.[1];
    const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    const result = await connector.deprovision(creds, { kind: 'vm' as any, name, externalId, zone, resourceGroup, region } as any);
    // Drop the inventory record(s) + any provisioned creds for this VM.
    if (resourceId) await this.prisma.resource.deleteMany({ where: { id: resourceId } }).catch(() => undefined);
    else await this.prisma.resource.deleteMany({ where: { provider: provider as any, type: 'compute' as any, name } }).catch(() => undefined);
    await this.prisma.vmCredential.deleteMany({ where: { userId: '__provisioned__', host: name } }).catch(() => undefined);
    await this.prisma.eventLog.create({ data: { type: 'control', severity: 'warning', title: `VM deleted (live): ${result.detail}`, provider: provider as any, resourceName: name } }).catch(() => undefined);
    return result.detail;
  }

  /**
   * Live execution of an approved provisioning request via the cloud connector.
   * Only reached when PROVISION_EXEC enables the provider (checked by the caller).
   * Creates real infrastructure and logs it.
   */
  async executeProvision(action: string, p: any): Promise<string> {
    const provider = String(p.provider ?? '').toLowerCase();
    if (action === 'vpn_request') throw new BadRequestException('live VPN deployment is not supported — see Help → Remote Provisioning.');

    const conn = await this.prisma.cloudConnection.findFirst({ where: { provider: provider as any } });
    if (!conn) throw new BadRequestException(`no ${provider} connection to provision into`);
    const connector = getConnector(provider);
    if (!connector.provision) throw new BadRequestException(`live provisioning not implemented for ${provider}`);

    const kind = action === 'vm_provision' ? 'vm' : action === 'disk_provision' ? 'disk' : 'network';
    const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    // Pass the whole request payload through so each connector reads the fields it needs.
    const { provider: _p, kind: _k, ...rest } = p ?? {};
    // Console firewall safety: if ports were requested but no source CIDR, scope to the MCMF server
    // (so the console still works) rather than ever opening a port to the whole internet.
    if (kind === 'vm' && String(rest.consolePorts ?? '').trim() && !String(rest.sourceCidrs ?? '').trim()) {
      const mcmfIp = (process.env.SSO_BASE_URL || 'https://localhost').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
      rest.sourceCidrs = `${mcmfIp}/32`;
    }
    // Optional: generate an SSH keypair, inject the PUBLIC half into the VM (key-auth), and vault the
    // PRIVATE half so the console connects key-based with no password. Triggered by keyAuth === 'key'.
    let generatedKey = '';
    if (kind === 'vm' && String(rest.keyAuth ?? '').toLowerCase() === 'key' && !/windows/i.test(String(p.image ?? ''))) {
      try { const k = await ephemeralKey(); rest.sshPublicKey = k.pub; generatedKey = k.priv; }
      catch (e) { this.log.warn(`ssh keygen: ${String(e)}`); }
    }
    const result = await connector.provision(creds, {
      ...rest,
      kind: kind as any,
      name: p.name,
      sizeGb: p.sizeGb ? Number(p.sizeGb) : undefined,
      osDiskSizeGb: p.osDiskSizeGb ? Number(p.osDiskSizeGb) : undefined,
      volumeSizeGb: p.volumeSizeGb ? Number(p.volumeSizeGb) : undefined,
      diskSizeGb: p.diskSizeGb ? Number(p.diskSizeGb) : undefined,
    });
    // Auto-store the admin creds (sealed) so the browser console authenticates with no re-typing.
    // The public IP is assigned asynchronously, so we key by VM NAME under a sentinel "__provisioned__"
    // user; the console resolves a host-IP → its Resource → name → this cred. sharedWith governs WHO
    // can use it: "all" = every user, JSON id array = selected users (see console.service resolution).
    if (kind === 'vm' && (p.adminUsername || p.adminPassword || generatedKey)) {
      const isWin = /windows/i.test(String(p.image ?? '')) || String(rest.consolePorts ?? '').includes('3389');
      const protocol = isWin ? 'rdp' : 'ssh';
      const sharedWith = await this.resolveShare(rest.shareScope, rest.shareUsers);
      const data = {
        username: String(p.adminUsername || ''),
        password: generatedKey ? '' : encryptJson(String(p.adminPassword || '')),
        privateKey: generatedKey ? encryptJson(generatedKey) : '',
        kind: 'vm', sharedWith,
      };
      await this.prisma.vmCredential
        .upsert({
          where: { userId_host_protocol: { userId: '__provisioned__', host: String(p.name), protocol } },
          update: data,
          create: { userId: '__provisioned__', host: String(p.name), protocol, ...data },
        })
        .catch((e) => this.log.warn(`store provisioned cred: ${String(e)}`));
    }
    await this.prisma.eventLog
      .create({ data: { type: 'control', severity: 'info', title: `Provisioned (live): ${result.detail}`, provider: provider as any, resourceName: p.name } })
      .catch(() => undefined);
    // Surface the new resource in Inventory immediately. Cloud discovery doesn't enumerate
    // every type (e.g. GCP/AWS VPC networks), so we insert a record here for ALL clouds/kinds.
    await this.recordProvisioned(provider, kind, p, result).catch((e) => this.log.warn(`inventory insert: ${String(e)}`));
    return result.detail;
  }

  /** Insert/refresh an Inventory row for a freshly provisioned resource (source='provisioned'). */
  private async recordProvisioned(provider: string, kind: string, p: any, result: { externalId?: string; detail?: string }) {
    const name = (result.externalId || p.name || '').toString();
    if (!name) return;
    const type = kind === 'network' ? 'network' : kind === 'disk' ? 'storage' : 'compute';
    const region = (p.region || p.zone || p.location || p.availabilityZone || 'global').toString();
    const SERVICE: Record<string, Record<string, string>> = {
      network: { gcp: 'VPC Network', aws: 'VPC', azure: 'Virtual Network' },
      compute: { gcp: 'Compute Engine', aws: 'EC2', azure: 'Virtual Machine' },
      storage: { gcp: 'Persistent Disk', aws: 'EBS Volume', azure: 'Managed Disk' },
    };
    const service = SERVICE[type]?.[provider] ?? type;
    const account = await this.prisma.cloudAccount.findFirst({ where: { provider: provider as any } });
    // Distinct externalId namespace so it never collides with a discovered record.
    const externalId = `provisioned:${provider}:${kind}:${name}`;
    await this.prisma.resource.upsert({
      where: { externalId },
      update: { name, status: 'running', lastSeenAt: new Date() },
      create: {
        name,
        externalId,
        provider: provider as any,
        type: type as any,
        region,
        status: 'running',
        service,
        source: 'provisioned',
        cloudAccountId: account?.id ?? null,
        properties: { provisionedBy: 'mcmf', kind, detail: result.detail ?? '' } as any,
        lastSeenAt: new Date(),
      },
    });
  }

  /** Remediate a risky rule (deny/revoke/disable). Operators are gated for approval. */
  async remediate(riskId: string, actor?: GateActor, bypassApproval = false) {
    const risk = await this.prisma.networkRisk.findUnique({ where: { id: riskId } });
    if (!risk) throw new NotFoundException('risk not found');

    if (!bypassApproval && actor) {
      const gate = await this.gate.check({
        action: 'network_remediate',
        actor,
        payload: { riskId },
        title: `Remediate ${risk.severity} exposure on ${risk.resourceName} (${risk.detail})`,
        resourceName: risk.resourceName,
      });
      if (gate.gated) return { ok: true, pending: true, detail: 'Awaiting admin approval — remediation queued.' };
    }

    const conn = await this.prisma.cloudConnection.findFirst({ where: { provider: risk.provider } });
    if (!conn) throw new BadRequestException('no connection for this provider');
    const connector = getConnector(conn.provider);
    if (!connector.remediateRule) throw new BadRequestException(`remediation not supported for ${conn.provider}`);

    const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    const result = await connector.remediateRule(creds, {
      resourceName: risk.resourceName,
      ruleName: risk.ruleName,
      source: risk.source,
      ports: risk.ports,
      protocol: risk.protocol,
    });
    // Remediated — drop the risk row and log it.
    await this.prisma.networkRisk.delete({ where: { id: riskId } }).catch(() => undefined);
    await this.prisma.eventLog
      .create({ data: { type: 'control', severity: 'info', title: `Network remediated: ${result.detail}`, provider: risk.provider, resourceName: risk.resourceName } })
      .catch(() => undefined);
    return result;
  }

  async overview() {
    const resources = await this.prisma.resource.findMany();

    // 1. Public exposure — anything with a public IP.
    const exposure = resources
      .filter((r) => (r.properties as any)?.publicIp)
      .map((r) => ({
        name: r.name,
        provider: r.provider,
        type: r.type,
        region: r.region,
        publicIp: (r.properties as any).publicIp as string,
        environment: classifyEnvironment(r as any),
      }));

    // 2. Network inventory by kind.
    const kindCounts: Record<string, { provider: string; kind: string; count: number }> = {};
    for (const r of resources) {
      const kind = networkKind(r.provider, r.properties, r.type);
      if (!kind) continue;
      const key = `${r.provider}|${kind}`;
      kindCounts[key] = kindCounts[key] ?? { provider: r.provider, kind, count: 0 };
      kindCounts[key].count++;
    }

    // 3. Segments — network resources grouped by provider + resource group/region.
    const segMap: Record<string, { provider: string; group: string; count: number }> = {};
    for (const r of resources) {
      if (!networkKind(r.provider, r.properties, r.type)) continue;
      const group = ((r.properties as any)?.resourceGroup as string) || r.region || 'default';
      const key = `${r.provider}|${group}`;
      segMap[key] = segMap[key] ?? { provider: r.provider, group, count: 0 };
      segMap[key].count++;
    }

    // 4. Latest scan risks.
    const risks = await this.prisma.networkRisk.findMany({ orderBy: { ts: 'desc' }, take: 200 });
    const sev = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
    for (const r of risks) sev[r.severity] = (sev[r.severity] ?? 0) + 1;

    return {
      exposure,
      inventory: Object.values(kindCounts).sort((a, b) => b.count - a.count),
      segments: Object.values(segMap).sort((a, b) => b.count - a.count),
      risks: risks.map((r) => ({ id: r.id, provider: r.provider, resourceName: r.resourceName, ruleName: r.ruleName, source: r.source, ports: r.ports, protocol: r.protocol, severity: r.severity, detail: r.detail })),
      summary: { exposed: exposure.length, networkResources: Object.values(kindCounts).reduce((s, k) => s + k.count, 0), risks: risks.length, bySeverity: sev },
    };
  }

  /** Fetch firewall/NSG rules from every connected cloud and flag risky ones. */
  async scan() {
    const conns = await this.prisma.cloudConnection.findMany();
    let total = 0;
    const perProvider: Record<string, number> = {};
    for (const conn of conns) {
      const connector = getConnector(conn.provider);
      if (!connector.getNetworkRules) continue;
      let rules: NetworkRule[] = [];
      try {
        const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
        rules = await connector.getNetworkRules(creds);
      } catch (err) {
        this.log.warn(`network scan ${conn.name} skipped: ${String((err as Error)?.message ?? err)}`);
        continue;
      }
      const risks = rules.map((r) => this.assess(r)).filter((x): x is NonNullable<typeof x> => !!x);
      await this.prisma.networkRisk.deleteMany({ where: { provider: conn.provider } });
      if (risks.length) {
        await this.prisma.networkRisk.createMany({
          data: risks.map((r) => ({ provider: conn.provider as any, resourceName: r.resourceName, ruleName: r.ruleName, source: r.source, ports: r.ports, protocol: r.protocol, severity: r.severity, detail: r.detail })),
        });
      }
      perProvider[conn.provider] = risks.length;
      total += risks.length;
    }
    await this.prisma.eventLog.create({ data: { type: 'finding', severity: total > 0 ? 'warning' : 'info', title: `Network scan: ${total} risky rule(s)` } }).catch(() => undefined);
    return { ...(await this.overview()), scanned: conns.length, found: total, perProvider };
  }

  /** Flag a rule as risky (inbound allow from a public source on sensitive ports). */
  private assess(r: NetworkRule): { resourceName: string; ruleName: string; source: string; ports: string; protocol: string; severity: string; detail: string } | null {
    if (r.direction !== 'inbound' || r.access !== 'allow' || !isPublicSource(r.source)) return null;

    const allPorts = r.ports === '*' || r.ports === '0-65535' || r.ports.toLowerCase() === 'all' || r.protocol === 'all';
    const hits: string[] = [];
    if (!allPorts) {
      for (const tok of r.ports.split(',')) {
        const t = tok.trim();
        if (t.includes('-')) {
          const [a, b] = t.split('-').map((n) => parseInt(n, 10));
          for (const [p, label] of Object.entries(SENSITIVE_PORTS)) if (Number(p) >= a && Number(p) <= b) hits.push(label);
        } else {
          const label = SENSITIVE_PORTS[parseInt(t, 10)];
          if (label) hits.push(label);
        }
      }
    }
    if (!allPorts && hits.length === 0) return null;

    let severity = 'medium';
    if (allPorts) severity = 'critical';
    else if (hits.some((h) => h === 'RDP' || h === 'SSH')) severity = 'high';
    else if (hits.some((h) => ['MySQL', 'PostgreSQL', 'MSSQL', 'MongoDB', 'Redis', 'Elasticsearch'].includes(h))) severity = 'high';

    const detail = allPorts
      ? `ALL ports open to ${r.source}`
      : `${hits.join(', ')} (port ${r.ports}) open to ${r.source}`;
    return { resourceName: r.resourceName, ruleName: r.ruleName, source: r.source, ports: r.ports, protocol: r.protocol, severity, detail };
  }
}
