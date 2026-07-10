import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const ENVIRONMENTS = ['production', 'staging', 'development', 'test', 'unknown'] as const;
export type EnvName = (typeof ENVIRONMENTS)[number];

const RULE_KINDS = new Set(['require_tag', 'required_tag_value', 'no_untagged', 'no_public_ip', 'allowed_regions', 'max_monthly_cost', 'no_public_admin_ports', 'require_encryption']);

/** Map a free-text token to an environment tier. */
function matchEnv(s: string): EnvName | '' {
  const v = (s || '').toLowerCase();
  if (/(^|[^a-z])(prod|prd|production|live)([^a-z]|$)/.test(v)) return 'production';
  if (/(^|[^a-z])(stag|stg|staging|uat|preprod|pre-prod)([^a-z]|$)/.test(v)) return 'staging';
  if (/(^|[^a-z])(dev|develop|development)([^a-z]|$)/.test(v)) return 'development';
  if (/(^|[^a-z])(test|qa|sandbox|sbx)([^a-z]|$)/.test(v)) return 'test';
  return '';
}

/** Classify a resource into an environment from its tags (preferred) or name. */
export function classifyEnvironment(r: { name: string; properties?: any }): EnvName {
  const tags = (r.properties?.tags ?? {}) as Record<string, string>;
  for (const key of ['environment', 'env', 'Environment', 'Env', 'stage', 'tier', 'ENVIRONMENT']) {
    if (tags[key]) {
      const m = matchEnv(tags[key]);
      if (m) return m;
    }
  }
  return matchEnv(r.name) || 'unknown';
}

@Injectable()
export class PoliciesService implements OnModuleInit {
  private readonly logger = new Logger('Policies');
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedIfEmpty();
    await this.seedZeroTrustGuardrails();
    setTimeout(() => void this.evaluate().catch(() => undefined), 25_000);
    setInterval(() => void this.evaluate().catch(() => undefined), 5 * 60_000);
  }

  /** Zero-trust baseline guardrails (tier-aware, prod strictest). Added once, idempotent by name. */
  private async seedZeroTrustGuardrails() {
    const zt = [
      { name: 'ZT: No internet-exposed admin ports (SSH/RDP) in Production', category: 'zero-trust', scopeEnv: 'production', ruleKind: 'no_public_admin_ports', ruleConfig: {}, effect: 'alert' },
      { name: 'ZT: No internet-exposed admin ports anywhere', category: 'zero-trust', scopeEnv: 'all', ruleKind: 'no_public_admin_ports', ruleConfig: {}, effect: 'audit' },
      { name: 'ZT: Encrypt data at rest (Production)', category: 'zero-trust', scopeEnv: 'production', ruleKind: 'require_encryption', ruleConfig: {}, effect: 'alert' },
      { name: 'ZT: No public IPs in Production (minimize attack surface)', category: 'zero-trust', scopeEnv: 'production', ruleKind: 'no_public_ip', ruleConfig: {}, effect: 'alert' },
      { name: 'ZT: Production resources must declare an Owner', category: 'zero-trust', scopeEnv: 'production', ruleKind: 'require_tag', ruleConfig: { tag: 'Owner' }, effect: 'alert' },
    ];
    for (const p of zt) {
      const exists = await this.prisma.policy.findFirst({ where: { name: p.name } });
      if (!exists) await this.prisma.policy.create({ data: p as any });
    }
  }

  private async seedIfEmpty() {
    if ((await this.prisma.policy.count()) > 0) return;
    const seed = [
      { name: 'Production resources must have an Owner tag', category: 'tagging', scopeEnv: 'production', ruleKind: 'require_tag', ruleConfig: { tag: 'Owner' }, effect: 'alert' },
      { name: 'No public IPs in Production', category: 'security', scopeEnv: 'production', ruleKind: 'no_public_ip', ruleConfig: {}, effect: 'alert' },
      { name: 'Every resource must declare an Environment tag', category: 'environment', scopeEnv: 'all', ruleKind: 'require_tag', ruleConfig: { tag: 'environment' }, effect: 'audit' },
      { name: 'All resources must be tagged', category: 'tagging', scopeEnv: 'all', ruleKind: 'no_untagged', ruleConfig: {}, effect: 'audit' },
      { name: 'Development monthly cost cap', category: 'cost', scopeEnv: 'development', ruleKind: 'max_monthly_cost', ruleConfig: { amount: 50 }, effect: 'audit' },
    ];
    for (const p of seed) await this.prisma.policy.create({ data: p as any });
    this.logger.log(`seeded ${seed.length} governance policies`);
  }

  // ── CRUD ──
  list() {
    return this.prisma.policy.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async create(body: any) {
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    if (!RULE_KINDS.has(body.ruleKind)) throw new BadRequestException(`ruleKind must be one of: ${[...RULE_KINDS].join(', ')}`);
    const p = await this.prisma.policy.create({
      data: {
        name: body.name.trim(),
        description: body.description ?? '',
        category: body.category ?? 'governance',
        scopeEnv: ENVIRONMENTS.includes(body.scopeEnv) || body.scopeEnv === 'all' ? body.scopeEnv : 'all',
        ruleKind: body.ruleKind,
        ruleConfig: body.ruleConfig ?? {},
        effect: body.effect === 'alert' ? 'alert' : 'audit',
        enabled: body.enabled ?? true,
      },
    });
    await this.evaluate();
    return { id: p.id };
  }

  async update(id: string, body: any) {
    const exists = await this.prisma.policy.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('policy not found');
    const data: any = {};
    for (const k of ['name', 'description', 'category', 'scopeEnv', 'ruleKind', 'ruleConfig', 'effect', 'enabled']) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    await this.prisma.policy.update({ where: { id }, data });
    await this.evaluate();
    return { ok: true };
  }

  async remove(id: string) {
    await this.prisma.policyViolation.deleteMany({ where: { policyId: id } });
    await this.prisma.policy.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }

  async violations(policyId?: string) {
    const rows = await this.prisma.policyViolation.findMany({
      where: policyId ? { policyId } : undefined,
      orderBy: { ts: 'desc' },
      take: 500,
    });
    return rows;
  }

  /** Resource counts + violation counts per environment, plus overall posture. */
  async environments() {
    const resources = await this.prisma.resource.findMany({ select: { name: true, properties: true } });
    const counts: Record<string, number> = {};
    for (const r of resources) {
      const env = classifyEnvironment(r as any);
      counts[env] = (counts[env] ?? 0) + 1;
    }
    const viols = await this.prisma.policyViolation.groupBy({ by: ['environment'], _count: true });
    const vmap: Record<string, number> = {};
    for (const v of viols) vmap[v.environment] = v._count;

    const policies = await this.prisma.policy.findMany();
    const checked = policies.reduce((s, p) => s + p.checkedCount, 0);
    const violations = policies.reduce((s, p) => s + p.violationCount, 0);

    return {
      environments: ENVIRONMENTS.map((env) => ({ env, resources: counts[env] ?? 0, violations: vmap[env] ?? 0 })),
      totals: {
        resources: resources.length,
        policies: policies.length,
        enabledPolicies: policies.filter((p) => p.enabled).length,
        violations,
        compliancePct: checked > 0 ? Math.round((1 - violations / checked) * 100) : 100,
      },
    };
  }

  // ── Engine ──
  async evaluate() {
    const [policies, resources, risks, findings] = await Promise.all([
      this.prisma.policy.findMany(),
      this.prisma.resource.findMany(),
      this.prisma.networkRisk.findMany().catch(() => [] as any[]),
      this.prisma.securityFinding.findMany().catch(() => [] as any[]),
    ]);
    // Zero-trust context: which resources expose admin ports publicly, or have open encryption findings.
    const adminExposed = new Set((risks as any[]).filter((r) => /SSH|RDP/i.test(r.detail ?? '') || /\b(22|3389)\b/.test(r.ports ?? '')).map((r) => r.resourceName));
    const encNeeded = new Set((findings as any[]).filter((f) => /encrypt/i.test(f.title ?? '') && f.status !== 'resolved').map((f) => f.resourceName));
    const ztCtx = { adminExposed, encNeeded };
    for (const policy of policies) {
      if (!policy.enabled) {
        await this.prisma.policyViolation.deleteMany({ where: { policyId: policy.id } });
        await this.prisma.policy.update({ where: { id: policy.id }, data: { checkedCount: 0, violationCount: 0, lastEvalAt: new Date() } });
        continue;
      }
      const scoped = resources.filter((r) => policy.scopeEnv === 'all' || classifyEnvironment(r as any) === policy.scopeEnv);
      const violations: { policyId: string; resourceId: string; resourceName: string; provider: any; environment: string; detail: string | null }[] = [];
      for (const r of scoped) {
        const res = this.checkRule(policy, r, ztCtx);
        if (!res.compliant) {
          violations.push({
            policyId: policy.id,
            resourceId: r.id,
            resourceName: r.name,
            provider: r.provider,
            environment: classifyEnvironment(r as any),
            detail: res.detail ?? null,
          });
        }
      }
      await this.prisma.policyViolation.deleteMany({ where: { policyId: policy.id } });
      if (violations.length) await this.prisma.policyViolation.createMany({ data: violations as any });
      await this.prisma.policy.update({
        where: { id: policy.id },
        data: { checkedCount: scoped.length, violationCount: violations.length, lastEvalAt: new Date() },
      });
    }
    return this.environments();
  }

  private checkRule(policy: any, r: any, ztCtx?: { adminExposed: Set<string>; encNeeded: Set<string> }): { compliant: boolean; detail?: string } {
    const tags = (r.properties?.tags ?? {}) as Record<string, string>;
    const cfg = (policy.ruleConfig ?? {}) as any;
    switch (policy.ruleKind) {
      case 'no_public_admin_ports': {
        const exposed = ztCtx?.adminExposed?.has(r.name);
        return { compliant: !exposed, detail: exposed ? 'SSH/RDP reachable from the internet — zero-trust requires no public admin ports' : undefined };
      }
      case 'require_encryption': {
        const needs = ztCtx?.encNeeded?.has(r.name);
        return { compliant: !needs, detail: needs ? 'data not encrypted at rest (open encryption finding)' : undefined };
      }
      case 'require_tag': {
        const t = cfg.tag ?? 'Owner';
        return { compliant: !!tags[t], detail: tags[t] ? undefined : `missing tag "${t}"` };
      }
      case 'required_tag_value': {
        const t = cfg.tag ?? '';
        return { compliant: tags[t] === cfg.value, detail: tags[t] === cfg.value ? undefined : `tag "${t}" must equal "${cfg.value}" (got "${tags[t] ?? '∅'}")` };
      }
      case 'no_untagged':
        return { compliant: Object.keys(tags).length > 0, detail: Object.keys(tags).length ? undefined : 'resource has no tags' };
      case 'no_public_ip': {
        const pip = r.properties?.publicIp;
        return { compliant: !pip, detail: pip ? `exposed public IP ${pip}` : undefined };
      }
      case 'allowed_regions': {
        const regions: string[] = cfg.regions ?? [];
        const ok = regions.length === 0 || regions.includes(r.region);
        return { compliant: ok, detail: ok ? undefined : `region "${r.region}" not in allowed list` };
      }
      case 'max_monthly_cost': {
        const amt = Number(cfg.amount ?? 0);
        const cost = Number(r.monthlyCost ?? 0);
        return { compliant: cost <= amt, detail: cost <= amt ? undefined : `cost ${cost.toFixed(2)} exceeds cap ${amt}` };
      }
      default:
        return { compliant: true };
    }
  }
}
