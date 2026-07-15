import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { sysParams, pInt } from '../../system-params';
import { AiopsService } from '../aiops/aiops.service';
import { PoliciesService } from '../policies/policies.service';
import { AlertingService } from '../alerting/alerting.service';
import { deriveCandidates, type Candidate, type ProposedChange } from './rules';

/**
 * Layer 12 — Continuous Feedback & Optimisation.
 *
 * Closes the loop the twelve-layer architecture names but nothing implemented: AIOps anomalies, governance
 * violations and the alert/workflow config are read together, run through the pure rule core (rules.ts),
 * and turned into concrete, reviewable proposals that write BACK into the control plane on approval.
 * Generation is continuous (self-rescheduling loop, same pattern as the AIOps scan loop); applying is a
 * deliberate human action, mirroring the confirm gate used for anomalies.
 */
@Injectable()
export class OptimizationService implements OnModuleInit {
  private readonly log = new Logger('Optimization');
  private generating = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiops: AiopsService,
    private readonly policies: PoliciesService,
    private readonly alerting: AlertingService,
  ) {}

  onModuleInit() {
    // Start after the AIOps scan loop (45s) so the first pass reads real detections rather than an empty table.
    setTimeout(() => void this.generateLoop(), 90_000);
  }

  /** Self-rescheduling feedback loop — operator-tunable (System Parameters: optimizationScanSec). */
  private async generateLoop(): Promise<void> {
    try {
      const r = await this.generate();
      if (r.created) this.log.log(`generated ${r.created} recommendation(s) from ${r.candidates} candidate(s)`);
    } catch (err) {
      this.log.warn(`generate failed: ${String((err as Error)?.message ?? err)}`);
    }
    const sec = pInt(await sysParams(this.prisma), 'optimizationScanSec', 'OPTIMIZATION_SCAN_SEC', 900);
    setTimeout(() => void this.generateLoop(), Math.max(300, sec) * 1000);
  }

  /**
   * Read the live control-plane signal, derive candidates from it, and persist the ones that aren't already
   * pending. Returns the rows created — an empty list is a valid, expected result on a quiet fleet.
   */
  async generate() {
    if (this.generating) return { created: 0, candidates: 0, skipped: 0, items: [] as any[] };
    this.generating = true;
    try {
      const [policies, violations, anomalies, rules, workflows] = await Promise.all([
        this.policies.list(),
        this.policies.violations(),
        this.aiops.feed({ limit: 500 }),
        this.alerting.listRules(),
        this.alerting.listWorkflows(),
      ]);

      const candidates = deriveCandidates({
        policies: policies.map((p) => ({ id: p.id, name: p.name, effect: p.effect, ruleKind: p.ruleKind })),
        violations: violations.map((v) => ({ policyId: v.policyId, resourceId: v.resourceId, ts: v.ts })),
        anomalies: anomalies.map((a) => ({ resourceId: a.resourceId, resourceName: a.resourceName, metric: a.metric, value: a.value, detectedAt: a.detectedAt })),
        rules: rules.map((r) => ({ metric: r.metric, kind: r.kind, enabled: r.enabled })),
        now: new Date(),
      });

      // De-duplicate against what's already pending, against proposals the operator recently DISMISSED
      // (otherwise a rejected proposal returns on the very next loop and dismiss never sticks), and against
      // workflows a previous apply() already created. Applied ones are NOT suppressed: if the condition
      // genuinely comes back, it should be raised again.
      const cooldownDays = pInt(await sysParams(this.prisma), 'optimizationDismissCooldownDays', 'OPTIMIZATION_DISMISS_COOLDOWN_DAYS', 7);
      const cooldownFrom = new Date(Date.now() - Math.max(1, cooldownDays) * 86_400_000);
      const suppressed = await this.prisma.optimizationRecommendation.findMany({
        where: { OR: [{ status: 'pending' }, { status: 'dismissed', dismissedAt: { gte: cooldownFrom } }] },
        select: { dedupeKey: true },
      });
      const pendingKeys = new Set(suppressed.map((p) => p.dedupeKey));
      const workflowNames = new Set(workflows.map((w) => w.name));
      const fresh = candidates.filter((c) => {
        if (pendingKeys.has(c.key)) return false;
        const proposedName = (c.proposedChange.newValue as any)?.name;
        return !(c.category === 'idle-rightsizing' && proposedName && workflowNames.has(proposedName));
      });

      if (fresh.length) {
        await this.prisma.optimizationRecommendation.createMany({
          data: fresh.map((c) => ({
            source: c.source,
            category: c.category,
            title: c.title,
            description: c.description,
            proposedChange: c.proposedChange as any,
            dedupeKey: c.key,
          })),
        });
      }
      const items = fresh.length
        ? await this.prisma.optimizationRecommendation.findMany({ where: { dedupeKey: { in: fresh.map((c) => c.key) }, status: 'pending' }, orderBy: { createdAt: 'desc' } })
        : [];
      return { created: fresh.length, candidates: candidates.length, skipped: candidates.length - fresh.length, items };
    } finally {
      this.generating = false;
    }
  }

  /** Recommendations, newest first — optionally filtered by status (same query style as the anomaly feed). */
  async list(status?: string) {
    const where = ['pending', 'applied', 'dismissed'].includes(String(status)) ? { status: String(status) } : undefined;
    return this.prisma.optimizationRecommendation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /**
   * Apply = write the proposed change back into the control plane. THIS is the human approval gate: nothing
   * mutates policy/alert/workflow config until an admin approves it here.
   */
  async apply(id: string, user: { sub?: string; email?: string }) {
    const rec = await this.prisma.optimizationRecommendation.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('recommendation not found');
    if (rec.status !== 'pending') throw new BadRequestException(`recommendation already ${rec.status}`);
    const change = rec.proposedChange as unknown as ProposedChange;
    let detail = '';
    try {
      detail = await this.applyChange(change);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      this.log.warn(`apply ${id} failed: ${msg}`);
      throw new BadRequestException(`Could not apply "${rec.title}": ${msg}`);
    }
    const appliedBy = String(user?.sub || user?.email || '').slice(0, 200);
    await this.prisma.optimizationRecommendation.update({ where: { id }, data: { status: 'applied', appliedAt: new Date(), appliedBy } });
    await this.prisma.eventLog
      .create({ data: { type: 'finding', severity: 'info', title: `Optimisation applied by ${appliedBy || 'unknown'} — ${rec.title}: ${detail}`.slice(0, 500) } })
      .catch(() => undefined);
    return { ok: true, id, status: 'applied', detail };
  }

  /**
   * Perform the real write. Existing service methods are used (not raw Prisma) so their validation runs —
   * PoliciesService.update re-evaluates the policy, AlertingService.createRule validates metric/comparator.
   */
  private async applyChange(change: ProposedChange): Promise<string> {
    switch (change?.target) {
      case 'Policy': {
        if (!change.targetId) throw new Error('no target policy id on the proposal');
        await this.policies.update(change.targetId, { [change.field]: change.newValue });
        return `Policy ${change.targetId}: ${change.field} → ${String(change.newValue)}`;
      }
      case 'AlertRule': {
        const v = (change.newValue ?? {}) as any;
        const rule = await this.alerting.createRule(v);
        return `AlertRule "${rule.name}" created (${rule.metric} ${rule.comparator} ${rule.threshold})`;
      }
      case 'AutomationWorkflow': {
        const v = (change.newValue ?? {}) as any;
        // Created DISABLED on purpose: a stop_vm workflow must be reviewed before it can act on a VM.
        const wf = await this.alerting.createWorkflow({
          name: v.name,
          trigger: v.trigger,
          triggerKind: v.triggerKind,
          triggerValue: v.triggerValue,
          actionType: v.actionType,
          actionConfig: { resourceId: v.resourceId ?? '' },
          enabled: false,
        });
        return `AutomationWorkflow "${wf.name}" created (disabled — review before enabling)`;
      }
      default:
        throw new Error(`unsupported target "${String(change?.target)}"`);
    }
  }

  /**
   * Dismiss = this proposal isn't wanted. The row is kept as an audit trail of what was considered, and
   * dismissedAt starts a cooldown (optimizationDismissCooldownDays, default 7) so the loop doesn't re-raise
   * the same proposal minutes later. After the cooldown it can return if the condition still holds.
   */
  async dismiss(id: string) {
    const rec = await this.prisma.optimizationRecommendation.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('recommendation not found');
    if (rec.status !== 'pending') throw new BadRequestException(`recommendation already ${rec.status}`);
    await this.prisma.optimizationRecommendation.update({ where: { id }, data: { status: 'dismissed', dismissedAt: new Date() } });
    return { ok: true, id, status: 'dismissed' };
  }
}

export type { Candidate };
