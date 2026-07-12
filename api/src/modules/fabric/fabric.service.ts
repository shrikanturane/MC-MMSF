import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { getConnector } from '../../connectors/factory';
import { decryptJson, encryptJson } from '../../connectors/crypto';

type Side = 'a' | 'b';

/**
 * Turnkey cross-cloud network fabric orchestrator. A governed, staged, RESUMABLE pipeline: it provisions a
 * network (VPC/VNet + subnet) and a site-to-site VPN gateway + connection in each of two clouds via provider
 * APIs, exchanges the assigned gateway public IPs (AWS's tunnel outside IPs appear only after its connection
 * is created, so the AWS side is connected first), wires both connections with a shared key, and hands the
 * result to the VPN monitor. Nothing billable is created until the fabric is ARMED (approval gate). Each
 * stage is idempotent-ish and advanced one step per tick, so long async waits (esp. Azure's ~30-45 minute
 * gateway) span multiple ticks without blocking.
 *
 * NOTE: the cloud gateway/connection calls (connector.fabricGateway/fabricConnection) are EXPERIMENTAL and
 * unverified against live billing-enabled accounts; on any provider error the fabric stops at status=error
 * with the provider's message so it can be corrected and retried.
 */
@Injectable()
export class FabricService implements OnModuleInit {
  private readonly log = new Logger('Fabric');
  private busy = new Set<string>();
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    setInterval(() => this.tick().catch((e) => this.log.warn(`tick: ${String((e as Error)?.message ?? e)}`)), 45_000);
  }
  private async tick() {
    const fabrics = await (this.prisma as any).networkFabric.findMany({ where: { armed: true, status: { notIn: ['up', 'error'] } } }).catch(() => []);
    for (const f of fabrics) if (!this.busy.has(f.id)) this.advance(f.id).catch(() => undefined);
  }

  /** Credentials for a provider from its connected CloudConnection. */
  private async credsFor(provider: string): Promise<any | null> {
    const conn = await this.prisma.cloudConnection.findFirst({ where: { provider: provider as any } }).catch(() => null);
    if (!conn?.credentials) return null;
    try { return decryptJson<Record<string, string>>(conn.credentials); } catch { return null; }
  }

  async list() {
    const rows = await (this.prisma as any).networkFabric.findMany({ orderBy: { createdAt: 'desc' } }).catch(() => []);
    return rows.map((f: any) => ({
      id: f.id, name: f.name, status: f.status, armed: f.armed, stage: f.stage,
      aProvider: f.aProvider, aRegion: f.aRegion, aCidr: f.aCidr, aSubnetCidr: f.aSubnetCidr, aNetworkId: f.aNetworkId, aGatewayId: f.aGatewayId, aGatewayIp: f.aGatewayIp, aConnId: f.aConnId,
      bProvider: f.bProvider, bRegion: f.bRegion, bCidr: f.bCidr, bSubnetCidr: f.bSubnetCidr, bNetworkId: f.bNetworkId, bGatewayId: f.bGatewayId, bGatewayIp: f.bGatewayIp, bConnId: f.bConnId,
      vpnLinkId: f.vpnLinkId, steps: f.steps ?? [], lastError: f.lastError,
      createdAt: f.createdAt?.toISOString?.() ?? null,
    }));
  }

  /**
   * Reject a region that clearly doesn't belong to its provider (the #1 fabric foot-gun: switching the
   * cloud in the create dialog but leaving the other cloud's default region). Azure locations have NO
   * dashes (eastus); AWS/GCP regions do (us-east-1 / us-central1). Fails fast with a friendly message
   * BEFORE the cloud API returns a cryptic 400. Returns an error string, or null when it looks valid.
   */
  private regionError(provider: string, region: string): string | null {
    const r = String(region || '').trim();
    if (!r) return `${provider.toUpperCase()} region is required.`;
    if (provider === 'azure') {
      if (r.includes('-') || !/^[a-z][a-z0-9]+$/.test(r)) return `"${r}" is not a valid Azure location — Azure locations have no dashes (e.g. eastus, westeurope, centralindia). It looks like a ${/^[a-z]{2}-[a-z]+-\d+$/.test(r) ? 'AWS' : 'non-Azure'} region — did you swap the region with the other side?`;
    } else if (provider === 'aws') {
      if (!/^[a-z]{2}-[a-z]+-\d+$/.test(r)) return `"${r}" is not a valid AWS region — AWS regions look like us-east-1, eu-west-2, ap-southeast-1${/^[a-z][a-z0-9]+$/.test(r) ? ' (that looks like an Azure location — did you swap the region with the other side?)' : ''}.`;
    } else if (provider === 'gcp') {
      if (!/^[a-z]+-[a-z]+\d+$/.test(r)) return `"${r}" is not a valid GCP region — GCP regions look like us-central1, europe-west1, asia-south1.`;
    }
    return null;
  }

  async create(body: any) {
    const prov = (p: string) => (['aws', 'azure', 'gcp'].includes(p) ? p : 'aws');
    const name = String(body.name || 'fabric').slice(0, 80);
    // AWS VPN tunnels require the PSK to be 8-64 chars of [A-Za-z0-9._] and NOT start with 0. A bare hex
    // string can start with '0' ("Value for parameter PreSharedKey is invalid"). Prefix a letter to be safe.
    const psk = String(body.psk || '').trim() || ('k' + randomBytes(20).toString('hex'));
    const [ap, bp] = [prov(body.aProvider), prov(body.bProvider)];
    const aErr = this.regionError(ap, body.aRegion); if (aErr) throw new BadRequestException(`Side A (${ap.toUpperCase()}): ${aErr}`);
    const bErr = this.regionError(bp, body.bRegion); if (bErr) throw new BadRequestException(`Side B (${bp.toUpperCase()}): ${bErr}`);
    return (this.prisma as any).networkFabric.create({
      data: {
        name, psk: encryptJson(psk),
        aProvider: prov(body.aProvider), aRegion: String(body.aRegion || '').slice(0, 40), aCidr: String(body.aCidr || '10.10.0.0/16'), aSubnetCidr: String(body.aSubnetCidr || '10.10.0.0/24'),
        bProvider: prov(body.bProvider), bRegion: String(body.bRegion || '').slice(0, 40), bCidr: String(body.bCidr || '10.20.0.0/16'), bSubnetCidr: String(body.bSubnetCidr || '10.20.0.0/24'),
      },
    });
  }

  /** Approval gate: nothing is provisioned until the fabric is armed. */
  async arm(id: string) {
    const f = await (this.prisma as any).networkFabric.findUnique({ where: { id } }).catch(() => null);
    if (!f) throw new BadRequestException('fabric not found');
    if (f.aProvider === f.bProvider) throw new BadRequestException('Pick two DIFFERENT clouds for a cross-cloud fabric.');
    // Region sanity BEFORE any billable/cloud call (catches drafts created before this validation existed).
    const aErr = this.regionError(f.aProvider, f.aRegion); if (aErr) throw new BadRequestException(`Side A (${String(f.aProvider).toUpperCase()}): ${aErr}`);
    const bErr = this.regionError(f.bProvider, f.bRegion); if (bErr) throw new BadRequestException(`Side B (${String(f.bProvider).toUpperCase()}): ${bErr}`);
    if (!(await this.credsFor(f.aProvider))) throw new BadRequestException(`Connect a ${f.aProvider.toUpperCase()} cloud account first.`);
    if (!(await this.credsFor(f.bProvider))) throw new BadRequestException(`Connect a ${f.bProvider.toUpperCase()} cloud account first.`);
    await (this.prisma as any).networkFabric.update({ where: { id }, data: { armed: true, status: 'provisioning', stage: 'net_a', lastError: '' } });
    this.advance(id).catch(() => undefined);
    return { ok: true };
  }

  /**
   * Edit a fabric's definition (providers, regions, CIDRs, name, PSK). Only while it's a DRAFT or has
   * ERRORED — never mid-provision or once up (those hold live cloud state; tear down first). Lets an
   * operator fix a bad region without deleting + recreating the whole fabric.
   */
  async update(id: string, body: any) {
    const f = await (this.prisma as any).networkFabric.findUnique({ where: { id } }).catch(() => null);
    if (!f) throw new BadRequestException('fabric not found');
    if (f.armed && !['error', 'draft'].includes(f.status)) throw new BadRequestException(`This fabric is "${f.status}" — tear it down before editing (it holds live cloud resources).`);
    const prov = (p: string, fallback: string) => (['aws', 'azure', 'gcp'].includes(p) ? p : fallback);
    const data: any = {};
    if (body.name !== undefined) data.name = String(body.name).slice(0, 80);
    if (typeof body.psk === 'string' && body.psk.trim()) data.psk = encryptJson(body.psk.trim());
    if (body.aProvider !== undefined) data.aProvider = prov(body.aProvider, f.aProvider);
    if (body.bProvider !== undefined) data.bProvider = prov(body.bProvider, f.bProvider);
    for (const k of ['aRegion', 'aCidr', 'aSubnetCidr', 'bRegion', 'bCidr', 'bSubnetCidr'] as const) if (body[k] !== undefined) data[k] = String(body[k]).slice(0, 40);
    // validate the resulting (merged) providers/regions
    const merged = { ...f, ...data };
    const aErr = this.regionError(merged.aProvider, merged.aRegion); if (aErr) throw new BadRequestException(`Side A (${String(merged.aProvider).toUpperCase()}): ${aErr}`);
    const bErr = this.regionError(merged.bProvider, merged.bRegion); if (bErr) throw new BadRequestException(`Side B (${String(merged.bProvider).toUpperCase()}): ${bErr}`);
    if (merged.aProvider === merged.bProvider) throw new BadRequestException('Pick two DIFFERENT clouds for a cross-cloud fabric.');
    // editing an errored fabric resets it to a clean draft so it can be re-armed
    if (f.status === 'error') { data.status = 'draft'; data.armed = false; data.lastError = ''; }
    await (this.prisma as any).networkFabric.update({ where: { id }, data });
    return { ok: true };
  }

  async retry(id: string) {
    const f = await (this.prisma as any).networkFabric.findUnique({ where: { id } }).catch(() => null);
    if (f) {
      // Re-validate before re-running — a raw cloud 400 (e.g. swapped region) won't fix itself on retry.
      const aErr = this.regionError(f.aProvider, f.aRegion); if (aErr) throw new BadRequestException(`Side A (${String(f.aProvider).toUpperCase()}): ${aErr} — fix it in Edit, then retry.`);
      const bErr = this.regionError(f.bProvider, f.bRegion); if (bErr) throw new BadRequestException(`Side B (${String(f.bProvider).toUpperCase()}): ${bErr} — fix it in Edit, then retry.`);
    }
    await (this.prisma as any).networkFabric.update({ where: { id }, data: { status: 'provisioning', lastError: '' } }).catch(() => undefined);
    this.advance(id).catch(() => undefined);
    return { ok: true };
  }

  async remove(id: string) {
    await (this.prisma as any).networkFabric.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }

  /**
   * Tear the fabric's provisioned cloud resources back down (VPN connection + gateway per side), delete the
   * handed-off monitor link, and reset the fabric to draft. Best-effort per cloud; networks (VPC/VNet, which
   * are free) are LEFT in place — remove them in the console if desired. EXPERIMENTAL, like provisioning.
   */
  async deprovision(id: string) {
    const f = await (this.prisma as any).networkFabric.findUnique({ where: { id } }).catch(() => null);
    if (!f) throw new BadRequestException('fabric not found');
    const results: string[] = [];
    for (const side of ['a', 'b'] as Side[]) {
      const provider = side === 'a' ? f.aProvider : f.bProvider;
      const creds = await this.credsFor(provider);
      const conn = getConnector(provider) as any;
      if (!creds || typeof conn.fabricTeardown !== 'function') { results.push(`${side}: skipped (${provider})`); continue; }
      try {
        const out = await conn.fabricTeardown(creds, {
          connId: side === 'a' ? f.aConnId : f.bConnId,
          gatewayId: side === 'a' ? f.aGatewayId : f.bGatewayId,
          networkId: side === 'a' ? f.aNetworkId : f.bNetworkId,
          name: this.safeName(f.name, side),
          region: side === 'a' ? f.aRegion : f.bRegion,
        });
        results.push(`${side.toUpperCase()} (${provider}): ${(out || []).join('; ')}`);
      } catch (e) { results.push(`${side.toUpperCase()} (${provider}) error: ${String((e as Error)?.message ?? e).slice(0, 200)}`); }
    }
    if (f.vpnLinkId) await (this.prisma as any).vpnLink.delete({ where: { id: f.vpnLinkId } }).catch(() => undefined);
    const steps = (Array.isArray(f.steps) ? f.steps : []).concat(results.map((detail) => ({ stage: 'teardown', status: 'ok', detail: String(detail).slice(0, 300) }))).slice(-60);
    await (this.prisma as any).networkFabric.update({ where: { id }, data: { armed: false, status: 'draft', stage: 'net_a', aGatewayId: '', aGatewayIp: '', aConnId: '', bGatewayId: '', bGatewayIp: '', bConnId: '', vpnLinkId: '', steps, lastError: '' } }).catch(() => undefined);
    return { ok: true, results };
  }

  private async step(id: string, stage: string, status: string, detail: string) {
    const f = await (this.prisma as any).networkFabric.findUnique({ where: { id }, select: { steps: true } }).catch(() => null);
    const steps = Array.isArray(f?.steps) ? f.steps : [];
    steps.push({ stage, status, detail: String(detail).slice(0, 300) });
    await (this.prisma as any).networkFabric.update({ where: { id }, data: { steps: steps.slice(-40) } }).catch(() => undefined);
  }

  // gateway subnet /27 for Azure GatewaySubnet, derived from the VNet CIDR (…/16 → x.x.255.224/27)
  private gwSubnet(cidr: string): string {
    const m = String(cidr).match(/^(\d+)\.(\d+)\./);
    return m ? `${m[1]}.${m[2]}.255.224/27` : '10.10.255.224/27';
  }

  /** Advance the pipeline by one stage. Safe to call repeatedly; re-entrancy guarded by `busy`. */
  async advance(id: string): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const f = await (this.prisma as any).networkFabric.findUnique({ where: { id } });
      if (!f || !f.armed || f.status === 'error' || f.status === 'up') return;
      const set = (data: any) => (this.prisma as any).networkFabric.update({ where: { id }, data });
      try {
        switch (f.stage) {
          case 'net_a': { const nid = await this.provisionNet(f, 'a'); await set({ aNetworkId: nid, stage: 'net_b' }); await this.step(id, 'net_a', 'ok', `network ${nid}`); break; }
          case 'net_b': { const nid = await this.provisionNet(f, 'b'); await set({ bNetworkId: nid, stage: 'gw_a' }); await this.step(id, 'net_b', 'ok', `network ${nid}`); break; }
          case 'gw_a': { const g = await this.provisionGw(f, 'a'); await set({ aGatewayId: g.gatewayId, aGatewayIp: g.publicIp, stage: 'gw_b' }); await this.step(id, 'gw_a', 'ok', `gw ${g.gatewayId} ip ${g.publicIp || '(pending)'}`); break; }
          case 'gw_b': { const g = await this.provisionGw(f, 'b'); await set({ bGatewayId: g.gatewayId, bGatewayIp: g.publicIp, stage: 'conn', status: 'connecting' }); await this.step(id, 'gw_b', 'ok', `gw ${g.gatewayId} ip ${g.publicIp || '(pending)'}`); break; }
          case 'conn': { const done = await this.connect(f); if (done) { await set({ stage: 'handoff' }); await this.step(id, 'conn', 'ok', 'both connections created'); } break; }
          case 'handoff': { const linkId = await this.handoff(id); await set({ vpnLinkId: linkId, stage: 'done', status: 'up' }); await this.step(id, 'handoff', 'ok', `monitored via VpnLink ${linkId}`); break; }
          default: break;
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 500);
        await set({ status: 'error', lastError: msg }).catch(() => undefined);
        await this.step(id, f.stage, 'error', msg);
      }
    } finally {
      this.busy.delete(id);
    }
  }

  /**
   * A cloud-safe resource name derived from the (free-text) fabric name. Azure/GCP reject spaces and
   * most punctuation ("invalid network name"), and GCP requires lowercase starting with a letter. Produce
   * lowercase [a-z0-9-], collapse/trim dashes, ensure it starts with a letter — valid on AWS/Azure/GCP.
   */
  private safeName(base: string, suffix = ''): string {
    let s = String(base || 'mcmf').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z]/.test(s)) s = `mcmf-${s}`;
    s = s.replace(/^-+|-+$/g, '').slice(0, 30) || 'mcmf';
    return `${s}${suffix ? `-${suffix}` : ''}`.replace(/-+$/g, '').slice(0, 40);
  }

  private async provisionNet(f: any, side: Side): Promise<string> {
    const provider = side === 'a' ? f.aProvider : f.bProvider;
    const creds = await this.credsFor(provider);
    if (!creds) throw new Error(`No connected ${provider.toUpperCase()} account.`);
    const conn = getConnector(provider) as any;
    if (typeof conn.provision !== 'function') throw new Error(`${provider} connector cannot provision a network.`);
    const r = await conn.provision(creds, { kind: 'network', name: this.safeName(f.name, side), region: side === 'a' ? f.aRegion : f.bRegion, cidr: side === 'a' ? f.aCidr : f.bCidr, subnetCidr: side === 'a' ? f.aSubnetCidr : f.bSubnetCidr });
    if (!r?.externalId) throw new Error(`${provider} network provisioning returned no id: ${r?.detail ?? ''}`);
    return String(r.externalId);
  }

  private async provisionGw(f: any, side: Side): Promise<{ gatewayId: string; publicIp: string }> {
    const provider = side === 'a' ? f.aProvider : f.bProvider;
    const creds = await this.credsFor(provider);
    if (!creds) throw new Error(`No connected ${provider.toUpperCase()} account.`);
    const conn = getConnector(provider) as any;
    if (typeof conn.fabricGateway !== 'function') throw new Error(`${provider} connector does not implement fabricGateway.`);
    const region = side === 'a' ? f.aRegion : f.bRegion;
    const networkId = side === 'a' ? f.aNetworkId : f.bNetworkId;
    return conn.fabricGateway(creds, { networkId, region, name: this.safeName(f.name, `${side}-gw`), gwSubnet: this.gwSubnet(side === 'a' ? f.aCidr : f.bCidr), gwSubnetCidr: this.gwSubnet(side === 'a' ? f.aCidr : f.bCidr) });
  }

  /** Create both connections. AWS side first (its outside IP only exists after its connection). Returns true when done. */
  private async connect(f: any): Promise<boolean> {
    // fresh copy (gateway IPs may have been set on a prior tick)
    f = await (this.prisma as any).networkFabric.findUnique({ where: { id: f.id } });
    // AWS assigns a VPN connection's tunnel OUTSIDE IP a few minutes AFTER creation, so the IP is usually
    // empty at fabricConnection() time. Poll for it here across ticks — otherwise the peer side waits on an
    // AWS gateway IP that's already-connected-but-not-yet-reported and the fabric hangs at conn forever.
    for (const side of ['a', 'b'] as Side[]) {
      const provider = side === 'a' ? f.aProvider : f.bProvider;
      const connId = side === 'a' ? f.aConnId : f.bConnId;
      const gwIp = side === 'a' ? f.aGatewayIp : f.bGatewayIp;
      if (provider !== 'aws' || !connId || gwIp) continue;
      const creds = await this.credsFor('aws');
      const c2 = getConnector('aws') as any;
      if (!creds || typeof c2.fabricConnectionOutsideIps !== 'function') continue;
      const ips: string[] = await c2.fabricConnectionOutsideIps(creds, { connId, region: side === 'a' ? f.aRegion : f.bRegion }).catch(() => []);
      if (ips[0]) {
        await (this.prisma as any).networkFabric.update({ where: { id: f.id }, data: side === 'a' ? { aGatewayIp: ips[0] } : { bGatewayIp: ips[0] } });
        f = await (this.prisma as any).networkFabric.findUnique({ where: { id: f.id } });
        await this.step(f.id, 'conn', 'ok', `${side.toUpperCase()} outside IP ${ips[0]}`);
      } else {
        await this.step(f.id, 'conn', 'wait', `waiting for AWS to assign side ${side.toUpperCase()} tunnel outside IP (a few min)`);
      }
    }
    const sides: Side[] = f.aProvider === 'aws' ? ['a', 'b'] : f.bProvider === 'aws' ? ['b', 'a'] : ['a', 'b'];
    for (const side of sides) {
      const other: Side = side === 'a' ? 'b' : 'a';
      const provider = side === 'a' ? f.aProvider : f.bProvider;
      const already = side === 'a' ? f.aConnId : f.bConnId;
      if (already) continue;
      const peerIp = other === 'a' ? f.aGatewayIp : f.bGatewayIp;
      if (!peerIp) { await this.step(f.id, 'conn', 'wait', `waiting for ${other.toUpperCase()} gateway public IP`); return false; }
      const creds = await this.credsFor(provider);
      if (!creds) throw new Error(`No connected ${provider.toUpperCase()} account.`);
      const conn = getConnector(provider) as any;
      // Azure connection needs its gateway fully provisioned (~30-45 min) — poll and wait across ticks.
      if (provider === 'azure' && typeof conn.fabricGatewayReady === 'function') {
        const rs: any = await conn.fabricGatewayReady(creds, { networkId: side === 'a' ? f.aNetworkId : f.bNetworkId, name: side === 'a' ? f.aGatewayId : f.bGatewayId });
        // back-compat: older adapters returned a bare boolean
        const ready = typeof rs === 'object' && rs ? !!rs.ready : !!rs;
        const state = typeof rs === 'object' && rs ? String(rs.state || '') : ready ? 'Succeeded' : 'Provisioning';
        const terminal = typeof rs === 'object' && rs ? !!rs.terminal : false;
        // A TERMINAL state (Failed/Canceled/not-found) never becomes ready — fail fast instead of waiting forever.
        if (terminal) throw new Error(`Azure VPN gateway is "${state}" — it will not finish. Tear down and re-Arm.`);
        if (!ready) { await (this.prisma as any).networkFabric.update({ where: { id: f.id }, data: { status: 'connecting', lastError: `Azure VPN gateway provisioning (state=${state}, ~30-45 min)…` } }).catch(() => undefined); await this.step(f.id, 'conn', 'wait', `Azure gateway ${state}`); return false; }
      }
      if (typeof conn.fabricConnection !== 'function') throw new Error(`${provider} connector does not implement fabricConnection.`);
      let dbpsk = ''; try { dbpsk = f.psk ? decryptJson<string>(f.psk) : ''; } catch { /* */ }
      const r = await conn.fabricConnection(creds, {
        gatewayId: side === 'a' ? f.aGatewayId : f.bGatewayId, region: side === 'a' ? f.aRegion : f.bRegion, networkId: side === 'a' ? f.aNetworkId : f.bNetworkId,
        peerIp, peerCidr: other === 'a' ? f.aCidr : f.bCidr, localCidr: side === 'a' ? f.aCidr : f.bCidr, psk: dbpsk, name: this.safeName(f.name, side),
      });
      const patch: any = side === 'a' ? { aConnId: r.connId } : { bConnId: r.connId };
      // AWS: its own public IP = the connection's tunnel outside IP, now available for the peer's connection.
      if (provider === 'aws' && Array.isArray(r.outsideIps) && r.outsideIps[0]) { if (side === 'a') patch.aGatewayIp = r.outsideIps[0]; else patch.bGatewayIp = r.outsideIps[0]; }
      await (this.prisma as any).networkFabric.update({ where: { id: f.id }, data: patch });
      f = await (this.prisma as any).networkFabric.findUnique({ where: { id: f.id } });
      await this.step(f.id, 'conn', 'ok', `${side.toUpperCase()} connection ${r.connId}`);
    }
    return !!(f.aConnId && f.bConnId);
  }

  /** Register the fabric with the VPN monitor as a monitor-only link (gateway↔gateway). */
  private async handoff(id: string): Promise<string> {
    const f = await (this.prisma as any).networkFabric.findUnique({ where: { id } });
    // AWS connection id (vpn-…) enables authoritative API status; otherwise the monitor uses a probe.
    const vpnConnId = /^vpn-/.test(f.aConnId) ? f.aConnId : /^vpn-/.test(f.bConnId) ? f.bConnId : (f.aConnId || f.bConnId || '');
    const link = await (this.prisma as any).vpnLink.create({
      data: {
        name: `${f.name} (fabric)`, tech: 'ipsec', manage: 'monitor', mode: 'site-to-site',
        aManual: true, aProvider: f.aProvider, aHost: f.aGatewayIp, aSubnet: f.aCidr, aName: `${f.aProvider} gateway`,
        bManual: true, bProvider: f.bProvider, bHost: f.bGatewayIp, bSubnet: f.bCidr, bName: `${f.bProvider} gateway`, bDevice: `${f.bProvider} VPN gateway`,
        peerType: f.bProvider, vpnConnId, psk: f.psk, monitorPorts: '443,22',
      },
    }).catch(() => null);
    return link?.id ?? '';
  }
}
