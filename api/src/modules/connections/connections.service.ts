import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Provider, AccountStatus } from '@prisma/client';
import { encryptJson, decryptJson } from '../../connectors/crypto';
import { getConnector, SUPPORTED_PROVIDERS } from '../../connectors/factory';
import { mapResourceType, deriveService } from '../../connectors/mapping';
import { AzureMetrics } from '../../connectors/azure.metrics';
import { AwsMetrics } from '../../connectors/aws.metrics';
import { GcpMetrics } from '../../connectors/gcp.metrics';
import { cleanCreds } from '../../connectors/adapter';
import { parseServiceAccountKey } from '../../connectors/gcp.auth';
import type { DiscoveredAsset, ProviderCredentials } from '../../connectors/adapter';

/** Credential fields each provider needs — drives the UI form and validation. */
export const PROVIDER_FIELDS: Record<string, { key: string; label: string; secret?: boolean; optional?: boolean; multiline?: boolean }[]> = {
  aws: [
    { key: 'accessKeyId', label: 'Access Key ID' },
    { key: 'secretAccessKey', label: 'Secret Access Key', secret: true },
    { key: 'region', label: 'Region (e.g. us-east-1)' },
    { key: 'endpoint', label: 'Endpoint URL (optional, e.g. LocalStack)', optional: true },
  ],
  azure: [
    { key: 'tenantId', label: 'Tenant ID' },
    { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client Secret', secret: true },
    { key: 'subscriptionId', label: 'Subscription ID' },
  ],
  gcp: [
    { key: 'serviceAccountKey', label: 'Service Account JSON Key (paste the whole file)', secret: true, multiline: true },
    { key: 'project', label: 'Project ID (optional — taken from the key if present)', optional: true },
    { key: 'orgId', label: 'Organization ID (optional — for Security Command Center findings)', optional: true },
    { key: 'billingTable', label: 'BigQuery billing export table (optional — project.dataset.table — for cost)', optional: true },
    { key: 'accessToken', label: 'OAuth Access Token (optional alternative to a key)', secret: true, optional: true },
  ],
  docker: [
    { key: 'host', label: 'TCP host (tcp://host:2375) — leave blank for local socket', optional: true },
    { key: 'socketPath', label: 'Socket path (default /var/run/docker.sock)', optional: true },
  ],
  linux: [
    { key: 'host', label: 'Host / IP' },
    { key: 'port', label: 'Port (default 22)', optional: true },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true, optional: true },
    { key: 'privateKey', label: 'Private Key (optional)', secret: true, optional: true },
  ],
  windows: [
    { key: 'host', label: 'Host / IP' },
    { key: 'port', label: 'Port (default 22)', optional: true },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true, optional: true },
  ],
  vmware: [
    { key: 'host', label: 'vCenter / ESXi host or IP' },
    { key: 'port', label: 'Port (default 443)', optional: true },
    { key: 'username', label: 'Username (e.g. administrator@vsphere.local)' },
    { key: 'password', label: 'Password', secret: true },
  ],
  esxi: [
    { key: 'host', label: 'ESXi host or IP (ESXi 7.0+ for the REST API)' },
    { key: 'port', label: 'Port (default 443)', optional: true },
    { key: 'username', label: 'Username (e.g. root)' },
    { key: 'password', label: 'Password', secret: true },
  ],
  nutanix: [
    { key: 'host', label: 'Prism Central / Element host or IP' },
    { key: 'port', label: 'Port (default 9440)', optional: true },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
  ],
  proxmox: [
    { key: 'host', label: 'Proxmox VE host or IP' },
    { key: 'port', label: 'Port (default 8006)', optional: true },
    { key: 'username', label: 'Username with realm (e.g. root@pam)' },
    { key: 'password', label: 'Password', secret: true },
  ],
  kvm: [
    { key: 'host', label: 'KVM/libvirt host or IP (SSH)' },
    { key: 'port', label: 'SSH port (default 22)', optional: true },
    { key: 'username', label: 'SSH username (in the libvirt group, or with sudo)' },
    { key: 'password', label: 'SSH password', secret: true, optional: true },
    { key: 'privateKey', label: 'SSH private key (optional)', secret: true, optional: true },
  ],
};

/** How often to auto-pull live state + metrics from every connected cloud. */
const AUTO_SYNC_MS = 120_000; // 2 minutes

@Injectable()
export class ConnectionsService implements OnModuleInit {
  private readonly logger = new Logger('ConnectionsSync');
  private autoSyncing = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Background poller: every 2 min, re-discover each cloud so VM power state,
   *  CPU and inventory stay current without a manual Sync. */
  onModuleInit() {
    setInterval(() => void this.autoSyncAll(), AUTO_SYNC_MS);
    // Kick a first pass shortly after boot so data is fresh quickly.
    setTimeout(() => void this.autoSyncAll(), 20_000);
    this.logger.log(`auto-sync started (every ${AUTO_SYNC_MS / 1000}s)`);
  }

  private async autoSyncAll() {
    if (this.autoSyncing) return; // never overlap runs
    this.autoSyncing = true;
    try {
      const conns = await this.prisma.cloudConnection.findMany({ select: { id: true, name: true } });
      for (const c of conns) {
        try {
          await this.sync(c.id);
        } catch (err) {
          this.logger.warn(`auto-sync ${c.name} skipped: ${String((err as Error)?.message ?? err)}`);
        }
      }
      await this.reconcileStale();
    } catch (err) {
      this.logger.warn(`auto-sync pass failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      this.autoSyncing = false;
    }
  }

  /**
   * Self-heal stale inventory each periodic scan, so ghosts disappear automatically:
   *  - 'provisioned' placeholders that real discovery never confirmed within the grace window
   *    (a failed/abandoned provision — e.g. an Azure VM that never actually came up); and
   *  - resources whose owning cloud account was removed (orphans).
   * Live discovered resources refresh lastSeenAt every pass, so they're never touched.
   */
  private async reconcileStale() {
    const STALE_PROVISION_MS = 15 * 60_000; // a real VM is discovered within a few 2-min passes
    const cutoff = new Date(Date.now() - STALE_PROVISION_MS);
    const ghosts = await this.prisma.resource.deleteMany({
      where: { source: 'provisioned', OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null, createdAt: { lt: cutoff } }] },
    }).catch(() => ({ count: 0 }));
    if (ghosts.count) this.logger.log(`reconcile: pruned ${ghosts.count} stale provisioned placeholder(s)`);
    const accounts = await this.prisma.cloudAccount.findMany({ select: { id: true } });
    if (accounts.length) {
      const orphans = await this.prisma.resource.deleteMany({
        where: { cloudAccountId: { notIn: accounts.map((a) => a.id) } },
      }).catch(() => ({ count: 0 }));
      if (orphans.count) this.logger.log(`reconcile: pruned ${orphans.count} orphaned resource(s)`);
    }
  }

  providers() {
    return SUPPORTED_PROVIDERS.map((p) => ({ provider: p, fields: PROVIDER_FIELDS[p] ?? [] }));
  }

  async list() {
    const conns = await this.prisma.cloudConnection.findMany({ orderBy: { createdAt: 'desc' } });
    // Never return credentials.
    return conns.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      accountRef: c.accountRef,
      status: c.status,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      lastSyncError: c.lastSyncError,
      assetsFound: c.assetsFound,
      createdAt: c.createdAt.toISOString(),
      // Cost/billing is a separate Cloud Connections concern (does not affect connectivity status).
      monthlyCost: c.monthlyCost ?? 0,
      currency: c.currency ?? 'USD',
      costNote: (c as any).costNote ?? '',
      costRefreshedAt: c.costRefreshedAt?.toISOString() ?? null,
    }));
  }

  async create(body: { name?: string; provider?: string; accountRef?: string; credentials?: Record<string, string> }) {
    const provider = body.provider as Provider;
    if (!provider || !(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`);
    }
    if (!body.name) throw new BadRequestException('name is required');
    const credentials = body.credentials ?? {};
    // Derive a sensible accountRef for the UI if not given.
    const accountRef =
      body.accountRef ||
      credentials.subscriptionId ||
      credentials.project ||
      parseServiceAccountKey(credentials.serviceAccountKey)?.project_id ||
      credentials.host ||
      credentials.accessKeyId ||
      '';
    const conn = await this.prisma.cloudConnection.create({
      data: {
        name: body.name,
        provider,
        accountRef,
        credentials: encryptJson(credentials),
        status: 'pending',
      },
    });
    return { id: conn.id, name: conn.name, provider: conn.provider, status: conn.status };
  }

  async test(id: string) {
    const conn = await this.getConn(id);
    const connector = getConnector(conn.provider);
    let creds: ProviderCredentials;
    try {
      creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    } catch {
      const detail = 'Stored credentials could not be decrypted (encryption key changed). Click Edit and re-enter the credentials, then Test again.';
      await this.prisma.cloudConnection.update({ where: { id }, data: { status: 'error', lastSyncError: detail } });
      return { ok: false, stages: [{ name: 'Credentials', ok: false, detail }], detail };
    }
    try {
      // The connection Test validates the CORE integration only (connectivity/discovery/provisioning).
      // Billing/cost is a separate Cloud Connections concern — it is NOT tested here and never blocks the
      // connection (a fresh connection legitimately has no billing export/Cost Explorer yet). Cost is
      // surfaced on the connection card + FinOps, and set up via Help → Cloud Setup.
      const result = await connector.test(creds);
      await this.prisma.cloudConnection.update({
        where: { id },
        data: { status: result.ok ? 'connected' : 'error', lastSyncError: result.ok ? null : result.detail },
      });
      return result;
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      await this.prisma.cloudConnection.update({ where: { id }, data: { status: 'error', lastSyncError: detail } });
      return { ok: false, stages: [{ name: 'Connector', ok: false, detail }], detail };
    }
  }

  async sync(id: string) {
    const conn = await this.getConn(id);
    const connector = getConnector(conn.provider);
    let creds: ProviderCredentials;
    try {
      creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    } catch {
      const detail = 'Stored credentials could not be decrypted (encryption key changed). Click Edit and re-enter the credentials, then Sync again.';
      await this.prisma.cloudConnection.update({ where: { id }, data: { status: 'error', lastSyncError: detail } });
      throw new BadRequestException(detail);
    }

    let assets: DiscoveredAsset[];
    try {
      assets = await connector.discover({ externalAccountId: conn.accountRef }, creds);
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      await this.prisma.cloudConnection.update({ where: { id }, data: { status: 'error', lastSyncError: detail } });
      throw new BadRequestException(`Discovery failed: ${detail}`);
    }

    // Ensure a CloudAccount exists for this connection.
    const region = assets[0]?.region ?? 'multi';
    const account = await this.prisma.cloudAccount.upsert({
      where: { connectionId: conn.id },
      create: {
        name: conn.name,
        provider: conn.provider,
        accountRef: conn.accountRef || conn.name,
        region,
        status: AccountStatus.connected,
        connectionId: conn.id,
      },
      update: { name: conn.name, provider: conn.provider, region, status: AccountStatus.connected },
    });

    // Upsert each discovered asset into Resource.
    const now = new Date();
    for (const a of assets) {
      const type = mapResourceType(a.resourceType, a.properties.azureType as string | undefined);
      const status = deriveStatus(a);
      const common = {
        name: a.name,
        provider: conn.provider,
        type,
        region: a.region,
        service: deriveService(conn.provider, a),
        status,
        cpuPct: a.cpuPct ?? 0,
        memoryPct: a.memoryPct ?? 0,
        monthlyCost: a.monthlyCost ?? 0,
        source: 'discovered',
        properties: a.properties as object,
        lastSeenAt: now,
        cloudAccountId: account.id,
      };
      await this.prisma.resource.upsert({
        where: { externalId: a.externalId },
        create: { externalId: a.externalId, ...common },
        update: common,
      });
    }

    // Prune resources from this account that disappeared.
    const seen = assets.map((a) => a.externalId);
    await this.prisma.resource.deleteMany({
      where: { cloudAccountId: account.id, source: 'discovered', externalId: { notIn: seen.length ? seen : ['__none__'] } },
    });

    // Reconcile: once a provisioned resource is picked up by real discovery (same
    // provider + name), drop its temporary 'provisioned' placeholder to avoid a duplicate.
    const discoveredNames = assets.map((a) => a.name).filter(Boolean);
    if (discoveredNames.length) {
      await this.prisma.resource.deleteMany({
        where: { provider: conn.provider, source: 'provisioned', name: { in: discoveredNames } },
      });
    }

    // Pull real CPU for compute instances so the inventory table shows live utilization.
    await this.refreshComputeCpu(conn.provider, assets, creds);

    // Roll up account aggregates.
    const agg = await this.prisma.resource.aggregate({
      where: { cloudAccountId: account.id },
      _count: true,
      _sum: { monthlyCost: true },
    });
    await this.prisma.cloudAccount.update({
      where: { id: account.id },
      data: { resourceCount: agg._count, monthlyCost: agg._sum.monthlyCost ?? 0 },
    });

    await this.prisma.cloudConnection.update({
      where: { id },
      data: { status: 'connected', lastSyncAt: now, lastSyncError: null, assetsFound: assets.length },
    });

    await this.prisma.eventLog
      .create({ data: { type: 'sync', severity: 'info', title: `Synced ${conn.name}: ${assets.length} resources`, provider: conn.provider } })
      .catch(() => undefined);

    return { ok: true, discovered: assets.length, account: account.name };
  }

  async update(id: string, body: { name?: string; accountRef?: string; credentials?: Record<string, string> }) {
    const conn = await this.getConn(id);
    const data: any = {};
    if (body.name) data.name = body.name;
    if (body.accountRef !== undefined) data.accountRef = body.accountRef;
    // Merge only non-empty credential fields so the user can update just the secret.
    if (body.credentials) {
      const changed = Object.fromEntries(Object.entries(body.credentials).filter(([, v]) => v !== ''));
      if (Object.keys(changed).length) {
        // Merge onto existing creds so the user can update just one field. If the
        // stored creds can't be decrypted (e.g. the seal key was rotated/lost),
        // fall back to the freshly-entered values instead of failing the save.
        let existing: Record<string, string> = {};
        try {
          existing = decryptJson<Record<string, string>>(conn.credentials);
        } catch {
          existing = {};
        }
        data.credentials = encryptJson({ ...existing, ...changed });
        data.status = 'pending';
      }
    }
    await this.prisma.cloudConnection.update({ where: { id }, data });
    return { ok: true };
  }

  /** For each discovered compute instance, fetch the latest CPU% and store it (best-effort). */
  private async refreshComputeCpu(provider: string, assets: DiscoveredAsset[], creds: ProviderCredentials) {
    const isCompute = (a: DiscoveredAsset) => {
      if (provider === 'azure') {
        const t = String(a.properties.azureType ?? '').toLowerCase();
        return t.includes('/virtualmachines') && !t.includes('/extensions');
      }
      if (provider === 'aws') return a.externalId.startsWith('i-');
      if (provider === 'gcp') return a.resourceType.includes('compute');
      return false;
    };
    const computes = assets.filter(isCompute).slice(0, 50); // cap per sync
    for (const a of computes) {
      try {
        let cpu: number | null = null;
        if (provider === 'azure') cpu = (await new AzureMetrics().collect(a.externalId, creds)).latest.cpuPct;
        else if (provider === 'aws') cpu = (await new AwsMetrics().collect(a.externalId, creds, a.region)).latest.cpuPct;
        else if (provider === 'gcp') cpu = (await new GcpMetrics().collect(a.externalId, creds)).latest.cpuPct;
        if (cpu != null) {
          await this.prisma.resource.update({ where: { externalId: a.externalId }, data: { cpuPct: cpu } });
        }
      } catch (err) {
        console.warn(`[connections] ${provider} metrics for ${a.name} skipped: ${String(err)}`);
      }
    }
  }

  async remove(id: string) {
    const conn = await this.getConn(id);
    const account = await this.prisma.cloudAccount.findUnique({ where: { connectionId: conn.id } });
    if (account) {
      await this.prisma.resource.deleteMany({ where: { cloudAccountId: account.id } });
      await this.prisma.cloudAccount.delete({ where: { id: account.id } });
    }
    await this.prisma.cloudConnection.delete({ where: { id } });
    return { ok: true };
  }

  private async getConn(id: string) {
    const conn = await this.prisma.cloudConnection.findUnique({ where: { id } });
    if (!conn) throw new NotFoundException('connection not found');
    return conn;
  }
}

function deriveStatus(a: DiscoveredAsset): any {
  const s = String(a.properties.state ?? a.properties.status ?? a.properties.provisioningState ?? '').toLowerCase();
  if (!s) return 'running';
  if (s.includes('run') || s.includes('succeeded') || s.includes('available') || s.includes('active')) return 'running';
  if (s.includes('stop') || s.includes('dealloc') || s.includes('exited') || s.includes('paused')) return 'stopped';
  if (s.includes('terminat') || s.includes('fail') || s.includes('error')) return 'terminated';
  if (s.includes('degrad') || s.includes('pending') || s.includes('creating')) return 'degraded';
  return 'running';
}
