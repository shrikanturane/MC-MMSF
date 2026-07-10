import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ConnectionsService } from '../connections/connections.service';
import { NetworkService } from '../network/network.service';
import { DatabaseService } from '../database/database.service';
import { ProvisionError } from '../../connectors/adapter';

interface Approver {
  sub: string;
  email: string;
  role: string;
}

/** Drop secret-ish fields so a payload can be safely returned to the client for editing. */
function sanitizePayload(p: any): Record<string, any> {
  if (!p || typeof p !== 'object') return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(p)) {
    if (/password|secret|psk/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly connections: ConnectionsService,
    private readonly network: NetworkService,
    private readonly database: DatabaseService,
  ) {}

  /** Admins see all requests; everyone else sees only their own. */
  async list(actor: Approver, status?: string) {
    const where: any = {};
    if (actor.role !== 'admin') where.requestedById = actor.sub;
    if (status) where.status = status;
    const rows = await this.prisma.approvalRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      title: r.title,
      resourceName: r.resourceName,
      status: r.status === 'pending' && r.expiresAt.getTime() < now ? 'expired' : r.status,
      requestedByEmail: r.requestedByEmail,
      mine: r.requestedById === actor.sub,
      approverEmail: r.approverEmail,
      result: r.result,
      phase: r.phase,
      remediation: r.remediation,
      retries: r.retries,
      retryable: r.status === 'failed' && (r.action.endsWith('_provision') || r.action === 'vpn_request'),
      // Sanitized payload (secrets stripped) so the UI can pre-fill an "edit & resubmit" form.
      payload: sanitizePayload(r.payload),
      decisionNote: r.decisionNote,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt.toISOString(),
    }));
  }

  policies() {
    return this.prisma.approvalPolicy.findMany({ orderBy: { action: 'asc' } });
  }

  async setPolicy(id: string, body: { label?: string; requiresApproval?: boolean; autoApproveAdmin?: boolean }) {
    const data: any = {};
    if (body.label !== undefined) data.label = String(body.label).trim();
    if (body.requiresApproval !== undefined) data.requiresApproval = !!body.requiresApproval;
    if (body.autoApproveAdmin !== undefined) data.autoApproveAdmin = !!body.autoApproveAdmin;
    await this.prisma.approvalPolicy.update({ where: { id }, data });
    return { ok: true };
  }

  /** Create (or upsert by action) an approval policy for a gated action type. */
  async createPolicy(body: { action?: string; label?: string; requiresApproval?: boolean; autoApproveAdmin?: boolean }) {
    const action = String(body.action ?? '').trim();
    if (!action) throw new BadRequestException('action is required');
    const label = String(body.label ?? '').trim() || action;
    return this.prisma.approvalPolicy.upsert({
      where: { action },
      create: { action, label, requiresApproval: body.requiresApproval ?? true, autoApproveAdmin: body.autoApproveAdmin ?? true },
      update: { label, ...(body.requiresApproval !== undefined ? { requiresApproval: !!body.requiresApproval } : {}), ...(body.autoApproveAdmin !== undefined ? { autoApproveAdmin: !!body.autoApproveAdmin } : {}) },
    });
  }

  async deletePolicy(id: string) {
    await this.prisma.approvalPolicy.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }

  async approve(id: string, approver: Approver) {
    const req = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('request not found');
    if (req.status !== 'pending') throw new BadRequestException(`request already ${req.status}`);
    if (req.expiresAt.getTime() < Date.now()) {
      await this.prisma.approvalRequest.update({ where: { id }, data: { status: 'expired' } });
      throw new BadRequestException('request has expired');
    }
    // Maker-checker (segregation of duties): when enabled, the requester can't approve their own
    // request — a DIFFERENT administrator must approve it.
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    if ((org as any)?.makerChecker && req.requestedById && req.requestedById === approver.sub) {
      throw new BadRequestException('Maker-checker is enabled — you cannot approve your own request. Another administrator must approve it.');
    }
    const out = await this.executeAndCapture(req);
    await this.prisma.approvalRequest.update({
      where: { id },
      data: { status: out.status, approverEmail: approver.email, decidedAt: new Date(), result: out.result, phase: out.phase, remediation: out.remediation },
    });
    await this.prisma.eventLog
      .create({ data: { type: 'control', severity: out.status === 'executed' ? 'info' : 'warning', title: `${approver.email} approved: ${req.title} (${out.status})`, resourceName: req.resourceName ?? undefined } })
      .catch(() => undefined);
    return { ok: out.status === 'executed', status: out.status, result: out.result };
  }

  /**
   * Re-run an already-approved deployment that failed — no second approval needed.
   * Only the original requester or an admin may retry, and only failed deploys.
   */
  async retry(id: string, actor: Approver) {
    const req = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('request not found');
    if (req.status !== 'failed') throw new BadRequestException(`only failed deployments can be retried (this is ${req.status})`);
    if (!(req.action.endsWith('_provision') || req.action === 'vpn_request')) throw new BadRequestException('this request type is not retryable');
    if (actor.role !== 'admin' && req.requestedById !== actor.sub) throw new ForbiddenException('you can only retry your own requests');

    const out = await this.executeAndCapture(req);
    await this.prisma.approvalRequest.update({
      where: { id },
      data: { status: out.status, decidedAt: new Date(), result: out.result, phase: out.phase, remediation: out.remediation, retries: { increment: 1 } },
    });
    await this.prisma.eventLog
      .create({ data: { type: 'control', severity: out.status === 'executed' ? 'info' : 'warning', title: `${actor.email} retried: ${req.title} (${out.status})`, resourceName: req.resourceName ?? undefined } })
      .catch(() => undefined);
    return { ok: out.status === 'executed', status: out.status, result: out.result };
  }

  /** Run the executor and translate any ProvisionError into {phase, remediation}. */
  private async executeAndCapture(req: { action: string; payload: any }): Promise<{ status: string; result: string; phase: string | null; remediation: string | null }> {
    try {
      const result = await this.execute(req);
      return { status: 'executed', result, phase: null, remediation: null };
    } catch (err) {
      const e = err as { message?: string; phase?: string; remediation?: string };
      return { status: 'failed', result: String(e?.message ?? err), phase: e?.phase ?? null, remediation: e?.remediation ?? null };
    }
  }

  async reject(id: string, approver: Approver, note?: string) {
    const req = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('request not found');
    if (req.status !== 'pending') throw new BadRequestException(`request already ${req.status}`);
    await this.prisma.approvalRequest.update({
      where: { id },
      data: { status: 'rejected', approverEmail: approver.email, decidedAt: new Date(), decisionNote: note ?? null },
    });
    await this.prisma.eventLog
      .create({ data: { type: 'control', severity: 'info', title: `${approver.email} rejected: ${req.title}`, resourceName: req.resourceName ?? undefined } })
      .catch(() => undefined);
    return { ok: true, status: 'rejected' };
  }

  /** Execute the approved action (bypassing the gate this time). */
  private async execute(req: { action: string; payload: any }): Promise<string> {
    const p = (req.payload ?? {}) as any;
    // Power actions are vm_start / vm_stop / vm_reboot — NOT vm_provision (that's a deploy).
    if (req.action.startsWith('vm_') && req.action !== 'vm_provision') {
      const r: any = await this.inventory.controlVm(p.id, p.action, undefined, true);
      return r?.detail ?? 'done';
    }
    if (req.action === 'connection_delete') {
      await this.connections.remove(p.id);
      return 'connection deleted';
    }
    if (req.action === 'network_remediate') {
      const r: any = await this.network.remediate(p.riskId, undefined, true);
      return r?.detail ?? 'remediated';
    }
    if (req.action === 'sync_to_prod') {
      return this.database.runApprovedSync(p.nodeId);
    }
    if (req.action === 'network_provision' || req.action === 'vm_provision' || req.action === 'disk_provision' || req.action === 'vpn_request') {
      return this.provision(req.action, p);
    }
    if (req.action === 'vm_delete') {
      // Gated by the same master switch as live provisioning (Settings → Advanced Cloud Integration).
      const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
      if (!(org as any)?.provisioningEnabled) throw new BadRequestException('Live delete is OFF — enable provisioning in Settings → Advanced Cloud Integration to execute approved deletes.');
      return this.network.executeDeprovision(p);
    }
    throw new BadRequestException(`no executor for action ${req.action}`);
  }

  /**
   * Provisioning executor. Live cloud resource creation (VM/network/disk/VPN) is a
   * billed, hard-to-reverse, provider-specific operation, so it is OFF by default
   * and enabled per-provider via PROVISION_EXEC (comma list, e.g. "azure,aws").
   * When disabled we return the authorized deployment plan + the exact write
   * permissions required (documented in Help → Remote Provisioning) so an operator
   * can apply it, rather than silently doing nothing.
   */
  private async provision(action: string, p: any): Promise<string> {
    const provider = String(p.provider ?? '').toLowerCase();
    // Master switch: Settings → Advanced Cloud Integration. Live create of VMs/resources is allowed
    // only when this is ON (and any PROVISION_EXEC allowlist permits the provider). OFF by default.
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    const masterOn = !!(org as any)?.provisioningEnabled;
    const exec = (process.env.PROVISION_EXEC ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const execAllows = exec.length === 0 || exec.includes(provider) || exec.includes('all');
    const live = masterOn && execAllows;

    const PERMS: Record<string, Record<string, string>> = {
      network_provision: {
        aws: 'ec2:CreateVpc, ec2:CreateSubnet, ec2:CreateRouteTable',
        azure: 'Network Contributor (Microsoft.Network/virtualNetworks/write)',
        gcp: 'roles/compute.networkAdmin (compute.networks.create)',
      },
      vm_provision: {
        aws: 'ec2:RunInstances (+ iam:PassRole if an instance profile is used)',
        azure: 'Virtual Machine Contributor (Microsoft.Compute/virtualMachines/write)',
        gcp: 'roles/compute.instanceAdmin.v1 (compute.instances.create)',
      },
      disk_provision: {
        aws: 'ec2:CreateVolume',
        azure: 'Disk Contributor (Microsoft.Compute/disks/write)',
        gcp: 'roles/compute.storageAdmin (compute.disks.create)',
      },
      vpn_request: {
        aws: 'ec2:CreateVpnGateway, ec2:CreateCustomerGateway, ec2:CreateVpnConnection',
        azure: 'Network Contributor (virtualNetworkGateways/write, connections/write)',
        gcp: 'roles/compute.networkAdmin (compute.vpnGateways.create, compute.vpnTunnels.create)',
      },
    };

    if (action === 'vpn_request') {
      // Honest status: only "deployed" when BOTH gateways are actually detected; otherwise
      // this is NOT deployed — fail with the phase + how to deploy (so it shows "not deployed" + Retry).
      const a = String(p.peerA).toLowerCase();
      const b = String(p.peerB).toLowerCase();
      const deployed = await this.network.isVpnDeployed(a, b);
      if (deployed) {
        return `Site-to-site VPN ${a.toUpperCase()} ↔ ${b.toUpperCase()} is deployed — VPN gateways detected on both ends.`;
      }
      throw new ProvisionError(
        `Not deployed — VPN gateways are not yet present on both ${a.toUpperCase()} and ${b.toUpperCase()}.`,
        'Gateway deployment',
        `Deploy the VPN gateway + IPsec tunnel on BOTH clouds using the pre-filled scripts (with your pre-shared key) in Settings → Advanced Cloud Integration → Site-to-Site VPN, open UDP 500/4500 + ESP both ways, then click ↻ Retry — it confirms once both gateways are detected.`,
      );
    }

    // Live execution enabled for this provider → actually create it via the connector.
    if (live) {
      return this.network.executeProvision(action, p);
    }

    const perm = PERMS[action]?.[provider] ?? 'see Help → Remote Provisioning';
    const what =
      action === 'vm_provision' ? `VM "${p.name}" (${p.size ?? '-'}, ${p.os ?? 'image'}${p.region ? ', ' + p.region : ''})` :
      action === 'disk_provision' ? `disk "${p.name}" (${p.sizeGb ?? '-'} GB${p.region ? ', ' + p.region : ''})` :
      `network "${p.name}" (${p.cidr ?? '-'}${p.region ? ', ' + p.region : ''})`;

    return `Authorized (governance only — live execution not enabled for ${provider.toUpperCase()}). Create ${what} using a credential with: ${perm}. See Help → Remote Provisioning for the full steps; it appears in the topology after the next sync.`;
  }
}
