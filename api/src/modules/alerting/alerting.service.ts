import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertingEngine } from './alerting.engine';
import { Severity } from '@prisma/client';

const METRICS = ['cpu', 'memory', 'disk', 'network'];
const COMPARATORS = ['gt', 'gte', 'lt', 'lte'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const ACTIONS = ['notify', 'webhook', 'stop_vm', 'restart_vm'];
const RULE_EVENTS = ['vm_power_off', 'vm_power_on', 'device_unreachable', 'agent_offline'];
const NOTIFY_CHANNELS = ['popup', 'email', 'whatsapp'];
const cleanNotify = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => NOTIFY_CHANNELS.includes(x)) : ['popup']);

@Injectable()
export class AlertingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: AlertingEngine,
  ) {}

  // ── Rules ─────────────────────────────────────────────
  listRules() {
    return this.prisma.alertRule.findMany({ orderBy: { createdAt: 'desc' } });
  }

  createRule(b: any) {
    if (!b?.name) throw new BadRequestException('name required');
    const kind = b.kind === 'event' ? 'event' : 'threshold';
    if (kind === 'event') {
      if (!RULE_EVENTS.includes(b.event)) throw new BadRequestException(`event must be ${RULE_EVENTS.join('|')}`);
    } else {
      if (!METRICS.includes(b.metric)) throw new BadRequestException(`metric must be ${METRICS.join('|')}`);
      if (!COMPARATORS.includes(b.comparator)) throw new BadRequestException(`comparator must be ${COMPARATORS.join('|')}`);
      if (typeof b.threshold !== 'number') throw new BadRequestException('threshold must be a number');
    }
    return this.prisma.alertRule.create({
      data: {
        name: b.name,
        kind,
        metric: kind === 'threshold' ? b.metric : 'cpu',
        comparator: kind === 'threshold' ? b.comparator : 'gt',
        threshold: kind === 'threshold' ? b.threshold : 0,
        event: kind === 'event' ? b.event : null,
        severity: (SEVERITIES.includes(b.severity) ? b.severity : 'high') as Severity,
        scopeProvider: b.scopeProvider || null,
        scopeEnv: b.scopeEnv || null,
        notify: cleanNotify(b.notify) as any,
        notifyEmail: (b.notifyEmail || '').trim() || null,
        notifyPhone: (b.notifyPhone || '').trim() || null,
        enabled: b.enabled !== false,
      },
    });
  }

  updateRule(id: string, b: any) {
    const data: any = {};
    for (const k of ['name', 'kind', 'metric', 'comparator', 'event', 'severity', 'scopeProvider', 'scopeEnv', 'notifyEmail', 'notifyPhone']) if (b[k] !== undefined) data[k] = (typeof b[k] === 'string' ? b[k].trim() : b[k]) || null;
    if (typeof b.threshold === 'number') data.threshold = b.threshold;
    if (b.notify !== undefined) data.notify = cleanNotify(b.notify) as any;
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    return this.prisma.alertRule.update({ where: { id }, data });
  }

  /** Send a test notification for a rule config (saved or unsaved) and report per-channel results. */
  testRuleNotify(b: any) {
    return this.engine.testRule({ name: b?.name, severity: b?.severity, notify: cleanNotify(b?.notify), notifyEmail: b?.notifyEmail, notifyPhone: b?.notifyPhone });
  }

  removeRule(id: string) {
    return this.prisma.alertRule.delete({ where: { id } });
  }

  // ── Workflows ─────────────────────────────────────────
  listWorkflows() {
    return this.prisma.automationWorkflow.findMany({ orderBy: { name: 'asc' } });
  }

  createWorkflow(b: any) {
    if (!b?.name) throw new BadRequestException('name required');
    const hasSteps = Array.isArray(b.steps) && b.steps.length > 0;
    const actionType = b.actionType ?? 'notify';
    if (!hasSteps && !ACTIONS.includes(actionType)) throw new BadRequestException(`actionType must be ${ACTIONS.join('|')}`);
    return this.prisma.automationWorkflow.create({
      data: {
        name: b.name,
        trigger: b.trigger || describeTrigger(b),
        status: b.enabled === false ? 'disabled' : 'enabled',
        triggerKind: ['any', 'severity', 'metric'].includes(b.triggerKind) ? b.triggerKind : 'any',
        triggerValue: b.triggerValue || null,
        actionType,
        actionConfig: b.actionConfig ?? {},
        conditions: Array.isArray(b.conditions) ? b.conditions : [],
        steps: Array.isArray(b.steps) ? b.steps : [],
        escalation: sanitizeEscalation(b.escalation),
      },
    });
  }

  updateWorkflow(id: string, b: any) {
    const data: any = {};
    for (const k of ['name', 'triggerKind', 'triggerValue', 'actionType']) if (b[k] !== undefined) data[k] = b[k];
    if (b.actionConfig !== undefined) data.actionConfig = b.actionConfig;
    if (Array.isArray(b.conditions)) data.conditions = b.conditions;
    if (Array.isArray(b.steps)) data.steps = b.steps;
    if (b.escalation !== undefined) data.escalation = sanitizeEscalation(b.escalation);
    if (b.trigger !== undefined) data.trigger = b.trigger;
    if (typeof b.enabled === 'boolean') data.status = b.enabled ? 'enabled' : 'disabled';
    return this.prisma.automationWorkflow.update({ where: { id }, data });
  }

  removeWorkflow(id: string) {
    return this.prisma.automationWorkflow.delete({ where: { id } });
  }

  // ── Notification channels ─────────────────────────────
  listChannels() {
    return this.prisma.notificationChannel.findMany({ orderBy: { createdAt: 'desc' } });
  }

  createChannel(b: any) {
    if (!b?.name || !b?.target) throw new BadRequestException('name and target required');
    const type = ['slack', 'webhook', 'email', 'pagerduty', 'whatsapp', 'group'].includes(b.type) ? b.type : 'webhook';
    return this.prisma.notificationChannel.create({
      data: { name: b.name, type, target: b.target, enabled: b.enabled !== false },
    });
  }

  async deliveries(limit = 100) {
    const rows = await this.prisma.notificationLog.findMany({ orderBy: { ts: 'desc' }, take: Math.min(limit, 500) });
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      channelName: r.channelName,
      channelType: r.channelType,
      target: r.target,
      subject: r.subject,
      status: r.status,
      error: r.error,
      attempts: r.attempts,
      nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
      canRetry: !!(r.payload && (r.payload as any).m), // has a saved message to re-send
    }));
  }

  deleteDelivery(id: string) {
    return this.prisma.notificationLog.delete({ where: { id } }).then(() => ({ ok: true }));
  }

  updateChannel(id: string, b: any) {
    const data: any = {};
    if (b.name !== undefined) data.name = b.name;
    if (b.target !== undefined) data.target = b.target;
    if (b.type !== undefined && ['slack', 'webhook', 'email', 'pagerduty', 'whatsapp', 'group'].includes(b.type)) data.type = b.type;
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    return this.prisma.notificationChannel.update({ where: { id }, data });
  }

  removeChannel(id: string) {
    return this.prisma.notificationChannel.delete({ where: { id } });
  }

  // ── Escalation policies ───────────────────────────────
  listEscalations() {
    return this.prisma.escalationPolicy.findMany({ orderBy: { afterMinutes: 'asc' } });
  }

  createEscalation(b: any) {
    if (!b?.name) throw new BadRequestException('name required');
    return this.prisma.escalationPolicy.create({
      data: {
        name: b.name,
        afterMinutes: typeof b.afterMinutes === 'number' ? b.afterMinutes : 15,
        severity: (SEVERITIES.includes(b.severity) ? b.severity : 'critical') as Severity,
        actionType: b.actionType === 'webhook' ? 'webhook' : 'notify',
        target: b.target || null,
        enabled: b.enabled !== false,
      },
    });
  }

  updateEscalation(id: string, b: any) {
    const data: any = {};
    if (b.name !== undefined) data.name = b.name;
    if (typeof b.afterMinutes === 'number') data.afterMinutes = b.afterMinutes;
    if (b.severity !== undefined && SEVERITIES.includes(b.severity)) data.severity = b.severity as Severity;
    if (b.actionType !== undefined) data.actionType = b.actionType === 'webhook' ? 'webhook' : 'notify';
    if (b.target !== undefined) data.target = b.target || null;
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    return this.prisma.escalationPolicy.update({ where: { id }, data });
  }

  removeEscalation(id: string) {
    return this.prisma.escalationPolicy.delete({ where: { id } });
  }

  // ── Alerts ────────────────────────────────────────────
  async listAlerts(status?: string) {
    const where = status ? { status: status as any } : {};
    const alerts = await this.prisma.alert.findMany({ where, orderBy: { raisedAt: 'desc' }, take: 200 });
    return alerts.map((a) => ({
      id: a.id,
      title: a.title,
      severity: a.severity,
      source: a.source,
      status: a.status,
      metric: a.metric,
      value: a.value,
      resourceName: a.resourceName,
      escalated: a.escalated,
      raisedAt: a.raisedAt.toISOString(),
      resolvedAt: a.resolvedAt?.toISOString() ?? null,
    }));
  }

  acknowledgeAlert(id: string) {
    return this.prisma.alert.update({ where: { id }, data: { status: 'acknowledged' } });
  }

  resolveAlert(id: string) {
    return this.prisma.alert.update({ where: { id }, data: { status: 'resolved', resolvedAt: new Date() } });
  }

  async evaluateNow() {
    await this.engine.evaluate();
    return { ok: true };
  }

  // ── Security tab overview ─────────────────────────────
  async overview() {
    const [active, rules, allWorkflows, legacyEscalations] = await Promise.all([
      this.prisma.alert.findMany({ where: { status: { not: 'resolved' } }, orderBy: { raisedAt: 'desc' } }),
      this.prisma.alertRule.count(),
      this.prisma.automationWorkflow.findMany({ select: { status: true, escalation: true } }),
      this.prisma.escalationPolicy.count({ where: { enabled: true } }),
    ]);
    const workflows = allWorkflows.filter((w) => w.status === 'enabled').length;
    // Unified escalations: enabled workflows carrying ≥1 escalation tier, plus any legacy policies.
    const escalations =
      allWorkflows.filter((w) => w.status === 'enabled' && Array.isArray(w.escalation) && (w.escalation as any[]).length > 0).length +
      legacyEscalations;
    const bySeverity = (s: string) => active.filter((a) => a.severity === s).length;
    return {
      kpis: {
        activeAlerts: active.length,
        critical: bySeverity('critical'),
        high: bySeverity('high'),
        escalated: active.filter((a) => a.escalated).length,
        rules,
        workflows,
        escalations,
      },
    };
  }
}

function describeTrigger(b: any): string {
  if (b.triggerKind === 'severity') return `severity = ${b.triggerValue}`;
  if (b.triggerKind === 'metric') return `metric = ${b.triggerValue}`;
  return 'any alert';
}

const STEP_TYPES = ['notify', 'webhook', 'stop_vm', 'restart_vm', 'create_approval', 'log'];
/** Normalize the escalation tiers: ordered, valid minutes, each with at least one known step. */
function sanitizeEscalation(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t: any) => ({
      afterMinutes: Math.max(1, Math.min(10080, Number(t?.afterMinutes) || 15)),
      steps: (Array.isArray(t?.steps) ? t.steps : [])
        .filter((s: any) => STEP_TYPES.includes(s?.type))
        .map((s: any) => ({ type: s.type, config: s.config ?? {} })),
    }))
    .filter((t) => t.steps.length > 0)
    .sort((a, b) => a.afterMinutes - b.afterMinutes);
}
