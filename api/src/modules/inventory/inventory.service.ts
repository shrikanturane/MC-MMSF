import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, Provider, ResourceType } from '@prisma/client';
import { decryptJson } from '../../connectors/crypto';
import { AzureMetrics } from '../../connectors/azure.metrics';
import { AwsMetrics } from '../../connectors/aws.metrics';
import { GcpMetrics } from '../../connectors/gcp.metrics';
import { cleanCreds } from '../../connectors/adapter';
import { getConnector } from '../../connectors/factory';
import { ApprovalGate, type GateActor } from '../approvals/approval-gate.service';
import type { PowerAction, ProviderCredentials } from '../../connectors/adapter';
import { mergeHostResources, buildMonByIp, liveHostStatus } from '../../common/host-identity';

const CONTROLLABLE = new Set<string>(['azure', 'aws', 'gcp', 'docker', 'linux', 'windows']);
// A cloud resource's status only refreshes on a successful connection sync. If it hasn't been seen
// in this long, the connection has stopped syncing (disconnected/credentials failing) — its last
// status is stale, so we surface it as 'disconnected' instead of a misleading "running".
const CLOUD_STALE_MS = 30 * 60_000;
const isStale = (lastSeenAt: Date | null | undefined) => (lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : Infinity) > CLOUD_STALE_MS;

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: ApprovalGate,
  ) {}

  /** Resource detail + live health metrics (real Azure Monitor for Azure VMs). */
  async resourceDetail(id: string) {
    const r = await this.prisma.resource.findUnique({
      where: { id },
      include: { cloudAccount: { select: { name: true, connectionId: true } } },
    });
    if (!r) throw new NotFoundException('resource not found');

    const base = {
      id: r.id,
      name: r.name,
      externalId: r.externalId,
      provider: r.provider,
      type: r.type,
      service: r.service,
      region: r.region,
      status: r.status,
      cpuPct: r.cpuPct,
      memoryPct: r.memoryPct,
      monthlyCost: Number(r.monthlyCost.toFixed(2)),
      source: r.source,
      account: r.cloudAccount?.name ?? null,
      properties: r.properties ?? {},
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    };

    // Live metrics for compute resources (Azure VM, AWS EC2, GCP instance).
    const azureType = String((r.properties as any)?.azureType ?? '').toLowerCase();
    const isAzureVm = r.provider === 'azure' && azureType.includes('/virtualmachines') && !azureType.includes('/extensions');
    const isAwsEc2 = r.provider === 'aws' && r.type === 'compute' && r.externalId.startsWith('i-');
    const isGcpVm = r.provider === 'gcp' && r.type === 'compute';
    const supported = isAzureVm || isAwsEc2 || isGcpVm;

    if (!supported || !r.cloudAccount?.connectionId) {
      const why = supported
        ? 'metrics unavailable (no linked connection).'
        : 'Live metrics are available for compute instances (Azure VM, AWS EC2, GCP Compute).';
      return { resource: base, metrics: { available: false, note: why } };
    }

    try {
      const conn = await this.prisma.cloudConnection.findUnique({ where: { id: r.cloudAccount.connectionId } });
      if (!conn) return { resource: base, metrics: { available: false, note: 'connection missing' } };
      const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));

      let metrics;
      if (isAzureVm) metrics = await new AzureMetrics().collect(r.externalId, creds, 3);
      else if (isAwsEc2) metrics = await new AwsMetrics().collect(r.externalId, creds, r.region, 3);
      else metrics = await new GcpMetrics().collect(r.externalId, creds, 3);

      return { resource: base, metrics };
    } catch (err) {
      return { resource: base, metrics: { available: false, note: `metrics error: ${String((err as Error)?.message ?? err)}` } };
    }
  }

  /** All VMs / hosts / containers across clouds, with state, IPs, size, OS and connect info. */
  async listVms() {
    const [rows, monitors] = await Promise.all([
      this.prisma.resource.findMany({
        where: { OR: [{ type: 'compute' }, { provider: { in: ['linux', 'windows', 'docker'] } }] },
        include: { cloudAccount: { select: { name: true } } },
        orderBy: [{ provider: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.monitor.findMany({ where: { enabled: true }, select: { target: true, altTargets: true, status: true } }),
    ]);
    // Live reachability keyed by IP (monitors re-checked every 60s) — the truest up/down for hosts.
    const monByIp = buildMonByIp(monitors);

    // Collapse duplicate host identities (same machine enrolled by IP + by hostname + secondary IPs)
    // into one row — shared platform-wide. Cloud VMs are untouched. See common/host-identity.ts.
    const effectiveRows = mergeHostResources(rows).sort((a, b) => (a.provider === b.provider ? a.name.localeCompare(b.name) : a.provider.localeCompare(b.provider)));

    return effectiveRows.map((r) => {
      const p = (r.properties as any) ?? {};
      const isDocker = r.provider === 'docker';
      const os = isDocker ? 'container' : String(p.os ?? (r.provider === 'windows' ? 'windows' : 'linux')).toLowerCase();
      const publicIp: string | null = isDocker ? null : (p.publicIp ?? null);
      const privateIp: string | null = isDocker ? null : (p.privateIp ?? (r.provider === 'linux' || r.provider === 'windows' ? r.region : null));
      const ip = publicIp ?? privateIp;
      // Up/down: containers from their state; cloud VMs from the cloud API (r.status). Linux/Windows
      // HOSTS reflect live reachability (heartbeat within ~120s OR an up monitor) — see liveHostStatus.
      const isHost = r.provider === 'linux' || r.provider === 'windows';
      let status: string = r.status;
      if (isDocker) {
        status = String(p.state ?? '').toLowerCase() === 'running' ? 'running' : 'stopped';
      } else if (isHost) {
        status = liveHostStatus(r, monByIp);
      } else if (isStale(r.lastSeenAt)) {
        // Cloud VM whose connection has stopped syncing — don't keep showing a stale "running".
        status = 'disconnected';
      }
      const containerId = isDocker ? r.externalId.replace(/^docker:/, '') : null;
      // Guest-agent hosts (push/pull endpoints) are monitored & secured but have no power-control
      // channel yet, so they appear without Start/Stop/Reboot (console/RDP still works if reachable).
      const agentSource = !!p.agentSource;
      return {
        id: r.id,
        name: r.name,
        provider: r.provider,
        account: r.cloudAccount?.name ?? (agentSource ? 'guest agent' : null),
        region: r.region,
        status,
        os,
        size: isDocker ? (p.image ?? null) : (p.size ?? p.instanceType ?? p.machineType ?? p.os ?? null),
        cpuPct: r.cpuPct,
        publicIp,
        privateIp,
        controllable: CONTROLLABLE.has(r.provider) && !agentSource,
        connect: {
          ip,
          rdp: os === 'windows' && ip ? { ip, port: 3389 } : null,
          ssh: !isDocker && os !== 'windows' && ip ? { ip, port: 22, cmd: `ssh <user>@${ip}` } : null,
          telnet: ip ? { ip, port: 23, cmd: `telnet ${ip} 23` } : null,
          docker: containerId ? { id: containerId, cmd: `docker exec -it ${containerId} sh` } : null,
        },
      };
    });
  }

  /** Power action (start/stop/reboot) on a cloud VM. */
  /**
   * Remove a resource from inventory + topology. Safe by design (optional FKs set null).
   * Caveats surfaced to the caller: a cloud VM reappears on the next discovery scan unless the
   * cloud account is disconnected; a host VM reappears if its agent is still installed and checking in.
   */
  async deleteResource(id: string, actor?: GateActor) {
    const r = await this.prisma.resource.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('resource not found');
    const isCloud = ['aws', 'azure', 'gcp'].includes(r.provider);
    const isHost = ['linux', 'windows', 'docker'].includes(r.provider);
    // A still-online agent will re-create this host on its next check-in — flag it.
    const agent = isHost ? await this.prisma.agent.findFirst({ where: { resourceId: id } }) : null;
    const agentOnline = !!(agent?.lastSeenAt && Date.now() - agent.lastSeenAt.getTime() < 5 * 60_000);
    await this.prisma.resource.delete({ where: { id } });
    await this.prisma.eventLog
      .create({ data: { type: 'inventory', severity: 'info', title: `Removed ${r.name} from inventory/topology${actor?.email ? ` by ${actor.email}` : ''}`, resourceName: r.name, provider: r.provider } })
      .catch(() => undefined);
    const note = isCloud
      ? 'Removed. Note: this is a cloud-discovered resource — it will reappear on the next cloud scan unless you disconnect the cloud account (Settings → Connections).'
      : agentOnline
        ? `Removed — but the MCMF agent on this host is still online and will re-register it on its next check-in. Shut down / uninstall that agent first (Command Center → ${agent?.name ?? 'agent'} → Shut down).`
        : 'Removed from inventory and topology.';
    return { ok: true, id, name: r.name, provider: r.provider, willReturn: isCloud || agentOnline, note };
  }

  async controlVm(id: string, action: PowerAction, actor?: GateActor, bypassApproval = false) {
    if (!['start', 'stop', 'reboot'].includes(action)) throw new BadRequestException('action must be start|stop|reboot');
    const r = await this.prisma.resource.findUnique({
      where: { id },
      include: { cloudAccount: { select: { connectionId: true } } },
    });
    if (!r) throw new NotFoundException('resource not found');
    if (!CONTROLLABLE.has(r.provider)) throw new BadRequestException(`power control not available for ${r.provider}`);
    if (!r.cloudAccount?.connectionId) throw new BadRequestException('resource has no linked connection');

    // Guarded actions by non-admins are queued for approval instead of executing.
    if (!bypassApproval && actor) {
      const gate = await this.gate.check({
        action: `vm_${action}`,
        actor,
        payload: { id, action },
        title: `${action.toUpperCase()} ${r.name}`,
        resourceRef: id,
        resourceName: r.name,
      });
      if (gate.gated) {
        await this.prisma.eventLog
          .create({ data: { type: 'control', severity: 'info', title: `${action} of ${r.name} awaiting approval`, resourceName: r.name, provider: r.provider } })
          .catch(() => undefined);
        return { ok: true, pending: true, detail: `Awaiting admin approval — request queued (${action} ${r.name}).` };
      }
    }

    const conn = await this.prisma.cloudConnection.findUnique({ where: { id: r.cloudAccount.connectionId } });
    if (!conn) throw new BadRequestException('connection missing');
    const connector = getConnector(conn.provider);
    if (!connector.control) throw new BadRequestException(`control not implemented for ${conn.provider}`);

    const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    const p = (r.properties as any) ?? {};
    let result: { ok: boolean; detail: string };
    try {
      result = await connector.control(action, { externalId: r.externalId, name: r.name, region: r.region, zone: p.zone, mac: p.mac }, creds);
    } catch (err) {
      // The cloud rejected the action — surface WHY (and how to fix) instead of a generic 500.
      const raw = String((err as Error)?.message ?? err);
      await this.prisma.eventLog
        .create({ data: { type: 'control', severity: 'critical', title: `${action} of ${r.name} failed`, detail: raw, resourceName: r.name, provider: r.provider } })
        .catch(() => undefined);
      throw new BadGatewayException(`Could not ${action} ${r.name}: ${controlHint(conn.provider, raw)}`);
    }

    // Optimistic local state so the UI reflects the action immediately.
    const optimistic = action === 'start' ? 'running' : action === 'stop' ? 'stopped' : 'running';
    const data: any = { status: optimistic };
    // Docker rows render state from properties.state — mirror it so the row updates at once.
    if (r.provider === 'docker') data.properties = { ...p, state: action === 'stop' ? 'exited' : 'running' };
    await this.prisma.resource.update({ where: { id }, data });
    await this.prisma.eventLog
      .create({ data: { type: 'control', severity: 'warning', title: `${action} requested: ${r.name}`, resourceName: r.name, provider: r.provider } })
      .catch(() => undefined);
    return result;
  }

  /** Generate an .rdp file body for a Windows VM (opens in the local RDP client). */
  async rdpFile(id: string): Promise<{ filename: string; content: string }> {
    const r = await this.prisma.resource.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('resource not found');
    const p = (r.properties as any) ?? {};
    const ip = p.publicIp ?? p.privateIp ?? (r.provider === 'windows' ? r.region : null);
    if (!ip) throw new BadRequestException('no IP address available for this VM');
    const content = [
      `full address:s:${ip}:3389`,
      'prompt for credentials:i:1',
      'administrative session:i:0',
      'screen mode id:i:2',
      'use multimon:i:0',
      'authentication level:i:2',
      `gatewayhostname:s:`,
      '',
    ].join('\r\n');
    return { filename: `${r.name}.rdp`, content };
  }

  async resourceTypes() {
    const grouped = await this.prisma.resource.groupBy({ by: ['type'], _count: true });
    const total = grouped.reduce((s, g) => s + g._count, 0);
    return {
      total,
      types: grouped
        .map((g) => ({ type: g.type as ResourceType, count: g._count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  async resources(params: { provider?: string; type?: string; q?: string; status?: string }) {
    const where: Prisma.ResourceWhereInput = {};
    if (params.provider && params.provider !== 'all') where.provider = params.provider as Provider;
    if (params.type && params.type !== 'all') where.type = params.type as ResourceType;
    if (params.status) where.status = params.status as any;
    if (params.q) where.name = { contains: params.q, mode: 'insensitive' };

    const resources = await this.prisma.resource.findMany({
      where,
      orderBy: { monthlyCost: 'desc' },
      take: 300,
      include: { cloudAccount: { select: { name: true } } },
    });

    return resources.map((r) => {
      const p = (r.properties as any) ?? {};
      // Cloud resources whose connection has stopped syncing show their stale status — flag them.
      const cloud = !['docker', 'linux', 'windows'].includes(r.provider);
      const status = cloud && isStale(r.lastSeenAt) ? 'disconnected' : r.status;
      return {
        id: r.id,
        name: r.name,
        externalId: r.externalId,
        provider: r.provider,
        type: r.type,
        service: r.service,
        region: r.region,
        status,
        cpuPct: r.cpuPct,
        memoryPct: r.memoryPct,
        diskPct: r.diskPct ?? 0,
        // Container disk/mem are absolute sizes (MB), surfaced from properties.
        diskUsedMB: typeof p.diskUsedMB === 'number' ? p.diskUsedMB : null,
        memUsedMB: typeof p.memUsedMB === 'number' ? p.memUsedMB : null,
        monthlyCost: Number(r.monthlyCost.toFixed(2)),
        account: r.cloudAccount?.name ?? null,
      };
    });
  }
}

/** Turn a raw cloud power-control error into an actionable, provider-specific hint. */
function controlHint(provider: string, raw: string): string {
  const r = raw.toLowerCase();
  if (/authorizationfailed|unauthorizedoperation|unauthorized|accessdenied|access denied|\b403\b|forbidden|not authorized|permission/.test(r)) {
    if (provider === 'azure') return `${raw}. The Azure app registration needs "Virtual Machine Contributor" on the subscription or the mcmf-provisioned resource group — "Reader" allows discovery but NOT power actions.`;
    if (provider === 'aws') return `${raw}. The IAM user needs ec2:StartInstances / ec2:StopInstances / ec2:RebootInstances — read-only policies allow discovery but not power control.`;
    if (provider === 'gcp') return `${raw}. The service account needs roles/compute.instanceAdmin.v1 — "Viewer" allows discovery but not power actions.`;
    return `${raw}. The connection's role lacks power-control (write) permission.`;
  }
  if (/notfound|\b404\b|could not be found|does not exist|no longer exists/.test(r)) return `${raw}. The VM may have been deleted or moved in the cloud — refresh Cloud Inventory.`;
  if (/expired|invalid.*credential|\b401\b|unauthenticated|invalid.*token|invalidauthenticationtoken/.test(r)) return `${raw}. The connection credentials are invalid or expired — update them in Settings → Cloud Connections.`;
  return raw;
}
