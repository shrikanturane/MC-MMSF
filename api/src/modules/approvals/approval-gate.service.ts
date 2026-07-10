import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { notifyPerson } from '../../mail/notify';

export interface GateActor {
  sub: string;
  email: string;
  role: string;
}

export interface GateInput {
  action: string;
  actor: GateActor;
  payload: Record<string, unknown>;
  title: string;
  resourceRef?: string;
  resourceName?: string;
}

const APPROVAL_TTL_MS = 1000 * 60 * 60 * 24; // 24h

/**
 * Decides whether a guarded action may execute now, or must be queued for approval.
 * Prisma-only (no service deps) so action controllers can inject it without import cycles.
 */
@Injectable()
export class ApprovalGate implements OnModuleInit {
  private readonly log = new Logger('ApprovalGate');
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Upsert each policy so new actions are added on deploy without overwriting toggles.
    const seed = [
      { action: 'vm_stop', label: 'Stop a virtual machine', requiresApproval: true },
      { action: 'vm_reboot', label: 'Reboot a virtual machine', requiresApproval: true },
      { action: 'vm_start', label: 'Start a virtual machine', requiresApproval: false },
      { action: 'connection_delete', label: 'Delete a cloud connection', requiresApproval: true },
      { action: 'network_remediate', label: 'Remediate a firewall / NSG rule', requiresApproval: true },
      // Dev→Prod sync must be approved even for admins (a separate approver signs off the release).
      { action: 'sync_to_prod', label: 'Sync Development → Production (full deploy)', requiresApproval: true, autoApproveAdmin: false },
    ];
    for (const p of seed) {
      await this.prisma.approvalPolicy.upsert({ where: { action: p.action }, update: { label: p.label }, create: p });
    }
    this.log.log(`approval policies ready (${seed.length})`);
  }

  /** @returns gated=true (request created, do NOT execute) or gated=false (proceed). */
  async check(input: GateInput): Promise<{ gated: boolean; requestId?: string }> {
    const policy = await this.prisma.approvalPolicy.findUnique({ where: { action: input.action } });
    if (!policy || !policy.requiresApproval) return { gated: false };
    if (input.actor.role === 'admin' && policy.autoApproveAdmin) return { gated: false };

    const req = await this.prisma.approvalRequest.create({
      data: {
        action: input.action,
        title: input.title,
        resourceRef: input.resourceRef ?? null,
        resourceName: input.resourceName ?? null,
        payload: input.payload as any,
        requestedById: input.actor.sub,
        requestedByEmail: input.actor.email,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    });
    // Notify approvers (email + WhatsApp) — best-effort, never blocks the request.
    this.notifyApprovers(input, req.id).catch((e) => this.log.warn(`approval notify failed: ${String(e)}`));
    return { gated: true, requestId: req.id };
  }

  /** Alert every active admin that an approval is pending — over both email and WhatsApp. */
  private async notifyApprovers(input: GateInput, requestId: string) {
    const admins = await this.prisma.user.findMany({ where: { role: 'admin', status: 'active' } });
    const subject = `[MCMF] Approval needed: ${input.title}`;
    const body =
      `A new request is awaiting your approval.\n\n` +
      `Action: ${input.action}\n` +
      `Requested by: ${input.actor.email}\n` +
      (input.resourceName ? `Resource: ${input.resourceName}\n` : '') +
      `\nReview & approve/reject in MCMF → Approvals (request ${requestId}).`;
    let delivered = 0;
    for (const a of admins) {
      const sent = await notifyPerson({ email: a.email, phone: a.contact }, subject, body);
      if (sent.length) delivered++;
    }
    this.log.log(`approval ${requestId}: notified ${delivered}/${admins.length} admin(s) via email/WhatsApp`);
  }
}
