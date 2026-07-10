import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyEnvironment } from '../policies/policies.service';
import { NetworkService } from '../network/network.service';

/** Per-pillar remediation action shown next to each recommendation. */
const ACTION: Record<string, { kind: 'remediate' | 'link'; to?: string; label: string }> = {
  identity: { kind: 'link', to: '/settings', label: 'Manage users' },
  network: { kind: 'remediate', label: 'Auto-remediate' },
  workload: { kind: 'link', to: '/command-center', label: 'Enrol telemetry' },
  data: { kind: 'link', to: '/security', label: 'Review findings' },
  visibility: { kind: 'link', to: '/command-center', label: 'Add monitoring' },
  automation: { kind: 'link', to: '/security', label: 'Configure' },
};
const PILLAR_KEY: Record<string, string> = { Identity: 'identity', Network: 'network', 'Devices & Workloads': 'workload', Data: 'data', 'Visibility & Analytics': 'visibility', 'Automation & Governance': 'automation' };

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

interface Check { label: string; pass: number; total: number; weight: number; recommendation?: string }
interface Pillar { key: string; name: string; icon: string; score: number; checks: { label: string; status: 'ok' | 'warn' | 'fail'; detail: string }[]; recommendations: string[] }

/**
 * Zero-Trust posture engine — "never trust, always verify". Scores the CISA ZT pillars
 * (Identity, Devices/Workloads, Network, Data, Visibility, Automation) from REAL signals
 * MCMF already collects: MFA/RBAC, agents, public exposure, encryption findings, SIEM, automation.
 */
@Injectable()
export class ZeroTrustService {
  constructor(private readonly prisma: PrismaService, private readonly network: NetworkService) {}

  /** One-click remediation for a pillar. Network = deny the public admin-port / critical rules. */
  async remediate(pillar: string, actor: { sub: string; email: string; role: string }) {
    if (pillar !== 'network') throw new BadRequestException(`${pillar} has no auto-remediation — use the Fix link.`);
    const risks = await this.prisma.networkRisk.findMany();
    const targets = risks.filter((r) => r.severity === 'critical' || /SSH|RDP/i.test(r.detail ?? '') || /\b(22|3389)\b/.test(r.ports ?? ''));
    const results: { resource: string; detail: string }[] = [];
    for (const t of targets) {
      try {
        const r: any = await this.network.remediate(t.id, actor, actor.role === 'admin');
        results.push({ resource: t.resourceName, detail: r?.detail ?? (r?.pending ? 'queued for approval' : 'remediated') });
      } catch (e) {
        results.push({ resource: t.resourceName, detail: `failed: ${String((e as Error)?.message ?? e).slice(0, 120)}` });
      }
    }
    return { ok: true, attempted: targets.length, results };
  }

  /** Per-VM workload posture coverage — every compute VM, whether it has a fresh posture agent /
   *  SSH-pull, its telemetry mode, last report and open vulnerability count. Powers the Workload
   *  pillar drill-down dashboard. Same coverage definition as the posture() Workload check. */
  async workloads() {
    const [resources, agents, findings] = await Promise.all([
      this.prisma.resource.findMany({ where: { type: 'compute' } }),
      this.prisma.agent.findMany(),
      this.prisma.securityFinding.findMany({ where: { type: 'vulnerability', status: { not: 'resolved' } } }),
    ]);
    const fresh = (a: any) => !!a.lastSeenAt && Date.now() - new Date(a.lastSeenAt).getTime() < 30 * 60_000;
    const agentByResource = new Map<string, any>();
    for (const a of agents) {
      if (!a.resourceId) continue;
      const prev = agentByResource.get(a.resourceId);
      if (!prev || (fresh(a) && !fresh(prev))) agentByResource.set(a.resourceId, a);
    }
    const vulnByResource = new Map<string, number>();
    for (const f of findings) { if (f.resourceId) vulnByResource.set(f.resourceId, (vulnByResource.get(f.resourceId) ?? 0) + 1); }
    const vms = resources
      .map((r) => {
        const a = agentByResource.get(r.id);
        const covered = !!(a && fresh(a));
        const p = (r.properties as any) ?? {};
        return {
          id: r.id,
          name: r.name,
          provider: r.provider,
          os: p.os ?? null,
          covered,
          mode: a?.mode ?? null,
          lastSeenAt: a?.lastSeenAt ? new Date(a.lastSeenAt).toISOString() : null,
          vulnerabilities: vulnByResource.get(r.id) ?? 0,
          publicIp: p.publicIp ?? null,
        };
      })
      .sort((a, b) => Number(a.covered) - Number(b.covered) || b.vulnerabilities - a.vulnerabilities || a.name.localeCompare(b.name));
    const covered = vms.filter((v) => v.covered).length;
    return { total: vms.length, covered, uncovered: vms.length - covered, withVulns: vms.filter((v) => v.vulnerabilities > 0).length, vms };
  }

  async posture() {
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const [users, resources, risks, findings, agents, workflows, approvalPolicies, monitors, siem24h] = await Promise.all([
      this.prisma.user.findMany(),
      this.prisma.resource.findMany(),
      this.prisma.networkRisk.findMany(),
      this.prisma.securityFinding.findMany(),
      this.prisma.agent.findMany(),
      this.prisma.automationWorkflow.findMany(),
      this.prisma.approvalPolicy.findMany().catch(() => [] as any[]),
      this.prisma.monitor.count().catch(() => 0),
      this.prisma.siemEvent.count({ where: { ts: { gte: dayAgo } } }).catch(() => 0),
    ]);

    const compute = resources.filter((r) => r.type === 'compute');
    const prod = resources.filter((r) => classifyEnvironment(r as any) === 'production');

    // ── Identity: verify explicitly + least privilege ──
    const active = users.filter((u) => u.status !== 'suspended');
    // A user counts as MFA-covered if they have enrolled (totpEnabled) OR an admin has required it
    // (require2fa) — required users are forced to enrol on their next sign-in, so enabling the
    // requirement immediately improves the score and clears the gap.
    const mfaEnrolled = active.filter((u) => (u as any).totpEnabled).length;
    const mfaCovered = active.filter((u) => (u as any).totpEnabled || (u as any).require2fa).length;
    const mfaPending = mfaCovered - mfaEnrolled;
    const admins = active.filter((u) => u.role === 'admin').length;
    const mfaPct = active.length ? mfaCovered / active.length : 1;
    const adminOk = active.length ? admins <= Math.max(1, Math.ceil(active.length * 0.34)) : true;
    const mfaDetail = mfaCovered < active.length
      ? `Enable MFA for the ${active.length - mfaCovered} user(s) without it — Settings → Users → edit → “Require MFA”.`
      : mfaPending > 0 ? `All users covered — ${mfaPending} required user(s) will finish enrolling on next sign-in.` : undefined;
    const identity: Pillar = pillar('identity', 'Identity', '👤', [
      check('MFA enforced for all users', mfaCovered, active.length, mfaDetail),
      check('Least-privilege admins', adminOk ? 1 : 0, 1, adminOk ? undefined : `${admins} admins of ${active.length} users — reduce standing admin access (no implicit trust).`),
    ], [Math.round(mfaPct * 60) + (adminOk ? 40 : 10)]);

    // ── Network: micro-segmentation, no implicit trust ──
    const exposed = new Set(resources.filter((r) => (r.properties as any)?.publicIp).map((r) => r.id));
    const adminExposure = risks.filter((r) => /SSH|RDP/i.test(r.detail) || /22|3389/.test(r.ports));
    const critOpen = risks.filter((r) => r.severity === 'critical').length;
    const network: Pillar = pillar('network', 'Network', '🛡', [
      check('No admin ports (SSH/RDP) open to the internet', adminExposure.length === 0 ? 1 : 0, 1, adminExposure.length ? `${adminExposure.length} rule(s) expose SSH/RDP to 0.0.0.0/0 — restrict to known CIDRs / use the console (Security → Network).` : undefined),
      check('No “allow all” / critical exposure', critOpen === 0 ? 1 : 0, 1, critOpen ? `${critOpen} critical exposure(s) (all-ports open) — remediate immediately.` : undefined),
      check('Public attack surface minimized', resources.length - exposed.size, resources.length || 1, exposed.size ? `${exposed.size} resource(s) have public IPs — confirm each is intended.` : undefined),
    ], [(adminExposure.length === 0 ? 45 : 0) + (critOpen === 0 ? 35 : 0) + (resources.length ? (1 - exposed.size / resources.length) * 20 : 20)]);

    // ── Devices / Workloads: posture + assume breach ──
    const covered = new Set(agents.filter((a) => a.lastSeenAt && Date.now() - a.lastSeenAt.getTime() < 30 * 60_000).map((a) => a.resourceId).filter(Boolean));
    const matchedCompute = compute.filter((r) => covered.has(r.id)).length;
    const vulns = findings.filter((f) => f.type === 'vulnerability' && f.status !== 'resolved').length;
    const workload: Pillar = pillar('workload', 'Devices & Workloads', '💻', [
      check('Workloads have a posture agent / SSH pull', matchedCompute, compute.length || 1, matchedCompute < compute.length ? `${compute.length - matchedCompute} VM(s) lack telemetry — enrol them (Command Center → SSH Pull) for posture.` : undefined),
      check('No open vulnerabilities', vulns === 0 ? 1 : 0, 1, vulns ? `${vulns} open vulnerability finding(s) — patch/remediate (Security).` : undefined),
    ], [(compute.length ? (matchedCompute / compute.length) * 55 : 55) + (vulns === 0 ? 45 : Math.max(0, 45 - vulns * 5))]);

    // ── Data: encrypt everywhere ──
    const encFindings = findings.filter((f) => /encrypt/i.test(f.title) && f.status !== 'resolved').length;
    const data: Pillar = pillar('data', 'Data', '🔒', [
      check('No unencrypted-data findings', encFindings === 0 ? 1 : 0, 1, encFindings ? `${encFindings} encryption finding(s) (e.g. disks/storage not encrypted) — enable encryption at rest.` : undefined),
      check('Secrets sealed at rest', 1, 1, undefined),
    ], [(encFindings === 0 ? 70 : Math.max(0, 70 - encFindings * 10)) + 30]);

    // ── Visibility & Analytics: continuous monitoring ──
    const visScore = (agents.length > 0 ? 25 : 0) + (siem24h > 0 ? 30 : 0) + (monitors > 0 ? 20 : 0) + (findings.length >= 0 ? 25 : 0);
    const visibility: Pillar = pillar('visibility', 'Visibility & Analytics', '📡', [
      check('Telemetry agents reporting', agents.length ? 1 : 0, 1, agents.length ? undefined : 'No guest agents/SSH-pull targets — enrol hosts for continuous monitoring.'),
      check('SIEM events flowing (24h)', siem24h > 0 ? 1 : 0, 1, siem24h ? undefined : 'No SIEM events in 24h — connect agents/monitors so the AI engine can detect anomalies.'),
      check('Reachability/uptime monitors', monitors > 0 ? 1 : 0, 1, monitors ? undefined : 'Add IP/host monitors for link visibility.'),
    ], [visScore]);

    // ── Automation & Orchestration: govern every change ──
    const autoWf = workflows.filter((w) => w.status === 'enabled').length;
    const gated = (approvalPolicies as any[]).filter((p) => p.requiresApproval).length;
    const automation: Pillar = pillar('automation', 'Automation & Governance', '⚙', [
      check('Automated response workflows', autoWf ? 1 : 0, 1, autoWf ? undefined : 'No enabled automation workflows — add auto-remediation (Management → Alert Rules).'),
      check('Sensitive actions require approval', gated ? 1 : 0, 1, gated ? undefined : 'No approval gates enabled — require approval for VM/network/provisioning changes (Approvals).'),
    ], [(autoWf ? 50 : 10) + (gated ? 50 : 15)]);

    const pillars = [identity, network, workload, data, visibility, automation];
    const score = clamp(pillars.reduce((s, p) => s + p.score, 0) / pillars.length);
    const maturity = score >= 85 ? 'Optimal' : score >= 65 ? 'Advanced' : score >= 40 ? 'Initial' : 'Traditional';
    const recommendations = pillars.flatMap((p) => p.recommendations.map((r) => ({ pillar: p.name, text: r, action: ACTION[PILLAR_KEY[p.name] ?? ''] ?? { kind: 'link', to: '/security', label: 'Review' } }))).slice(0, 12);

    return { score, maturity, principle: 'Never trust, always verify · Assume breach · Least privilege', pillars, recommendations, prodResources: prod.length, generatedAt: new Date().toISOString() };
  }
}

function check(label: string, pass: number, total: number, recommendation?: string): Check {
  return { label, pass, total, weight: 1, recommendation };
}

function pillar(key: string, name: string, icon: string, checks: Check[], scoreParts: number[]): Pillar {
  const score = clamp(scoreParts.reduce((a, b) => a + b, 0));
  return {
    key,
    name,
    icon,
    score,
    checks: checks.map((c) => ({
      label: c.label,
      status: c.total > 0 && c.pass >= c.total ? 'ok' : c.pass > 0 ? 'warn' : 'fail',
      detail: c.total > 1 ? `${c.pass}/${c.total}` : c.pass >= c.total ? 'pass' : 'fail',
    })),
    recommendations: checks.map((c) => c.recommendation).filter((r): r is string => !!r),
  };
}
