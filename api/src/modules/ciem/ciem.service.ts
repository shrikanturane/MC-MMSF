/**
 * CIEM-lite — Cloud Infrastructure Entitlement Management (thesis 6.3/6.4).
 *
 * Ingests identities + attached roles/policies from connected clouds (best-effort:
 * AWS IAM, Azure role assignments, GCP project IAM), classifies each identity's
 * privilege tier, then reports:
 *   - over-provisioned identities (admin-tier or wildcard grants, esp. when unused)
 *   - unused identities (no sign of activity ≥90 days where the provider exposes it)
 *   - cross-cloud drift: the SAME person (matched by email) holding materially
 *     different privilege tiers on different providers
 *   - a cross-cloud consistency score
 *
 * The pilot deliberately kept live IAM out of scope, so validation runs against a
 * SANDBOX: seedSandbox() plants labelled identities (ground truth) and runEval()
 * scores detection precision/recall — candidate-supervised, no production IAM touched.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptJson } from '../../connectors/crypto';
import { cleanCreds } from '../../connectors/adapter';
import { getAzureToken } from '../../connectors/azure.auth';
import { getGcpToken } from '../../connectors/gcp.auth';
import { IAMClient, ListUsersCommand, ListAttachedUserPoliciesCommand } from '@aws-sdk/client-iam';

const CIEM_TITLE = 'CIEM eval trial';
const UNUSED_DAYS = 90;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Classify a privilege tier from attached role/policy names — pure, provider-agnostic. */
export function classifyPrivilege(permissions: string[]): 'admin' | 'write' | 'read' | 'custom' {
  const joined = permissions.join(' ').toLowerCase();
  if (/administratoraccess|\bowner\b|roles\/owner|\*:\*|fullaccess.*\*|globaladministrator|\badmin\b/.test(joined)) return 'admin';
  if (/contributor|editor|roles\/editor|poweruser|write/.test(joined)) return 'write';
  if (/readonly|reader|viewer|roles\/viewer|read-only/.test(joined)) return 'read';
  return permissions.length ? 'custom' : 'read';
}

const TIER_RANK: Record<string, number> = { read: 0, custom: 1, write: 2, admin: 3 };

export interface CiemFinding {
  identityId: string;
  provider: string;
  name: string;
  email: string | null;
  kind: string;
  category: 'over-provisioned' | 'unused' | 'drift';
  detail: string;
}

@Injectable()
export class CiemService {
  private readonly log = new Logger('Ciem');

  constructor(private readonly prisma: PrismaService) {}

  // ── Live ingestion (best-effort; missing IAM permissions surface as per-provider errors) ──

  async syncAll(): Promise<{ synced: Record<string, number>; errors: Record<string, string> }> {
    const connections = await this.prisma.cloudConnection.findMany();
    const synced: Record<string, number> = {};
    const errors: Record<string, string> = {};
    for (const conn of connections) {
      try {
        const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials)) as Record<string, string>;
        let identities: { externalId: string; name: string; email: string | null; kind: string; permissions: string[]; lastUsedAt: Date | null }[] = [];
        if (conn.provider === 'aws') identities = await this.ingestAws(creds);
        else if (conn.provider === 'azure') identities = await this.ingestAzure(creds);
        else if (conn.provider === 'gcp') identities = await this.ingestGcp(creds);
        else continue;

        for (const it of identities) {
          await this.prisma.cloudIdentity.upsert({
            where: { provider_externalId: { provider: conn.provider, externalId: it.externalId } },
            update: { name: it.name, email: it.email, kind: it.kind, permissions: it.permissions, privilege: classifyPrivilege(it.permissions), lastUsedAt: it.lastUsedAt, connectionId: conn.id, source: 'cloud', syncedAt: new Date() },
            create: { provider: conn.provider, externalId: it.externalId, name: it.name, email: it.email, kind: it.kind, permissions: it.permissions, privilege: classifyPrivilege(it.permissions), lastUsedAt: it.lastUsedAt, connectionId: conn.id, source: 'cloud' },
          });
        }
        synced[conn.provider] = (synced[conn.provider] ?? 0) + identities.length;
      } catch (err) {
        errors[conn.provider] = String((err as Error)?.message ?? err).slice(0, 200);
      }
    }
    this.log.log(`CIEM sync: ${JSON.stringify(synced)}${Object.keys(errors).length ? ` errors=${JSON.stringify(errors)}` : ''}`);
    return { synced, errors };
  }

  private async ingestAws(creds: Record<string, string>) {
    const iam = new IAMClient({
      region: 'us-east-1', // IAM is global
      credentials: { accessKeyId: creds.accessKeyId ?? '', secretAccessKey: creds.secretAccessKey ?? '' },
    });
    const users = await iam.send(new ListUsersCommand({ MaxItems: 200 }));
    const out: { externalId: string; name: string; email: string | null; kind: string; permissions: string[]; lastUsedAt: Date | null }[] = [];
    for (const u of users.Users ?? []) {
      const pol = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: u.UserName })).catch(() => null);
      out.push({
        externalId: u.Arn ?? (u.UserName as string),
        name: u.UserName ?? 'unknown',
        email: u.UserName?.includes('@') ? u.UserName : null,
        kind: 'user',
        permissions: (pol?.AttachedPolicies ?? []).map((p) => p.PolicyName ?? '').filter(Boolean),
        lastUsedAt: u.PasswordLastUsed ?? null,
      });
    }
    return out;
  }

  private async ingestAzure(creds: Record<string, string>) {
    const token = await getAzureToken(creds as any);
    const sub = creds.subscriptionId;
    const [assignRes, defRes] = await Promise.all([
      fetch(`https://management.azure.com/subscriptions/${encodeURIComponent(sub ?? '')}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01`, { headers: { authorization: `Bearer ${token}` } }),
      fetch(`https://management.azure.com/subscriptions/${encodeURIComponent(sub ?? '')}/providers/Microsoft.Authorization/roleDefinitions?api-version=2022-04-01`, { headers: { authorization: `Bearer ${token}` } }),
    ]);
    if (!assignRes.ok) throw new Error(`azure roleAssignments ${assignRes.status}: ${(await assignRes.text()).slice(0, 160)}`);
    const assigns = ((await assignRes.json()) as any).value ?? [];
    const defs = defRes.ok ? (((await defRes.json()) as any).value ?? []) : [];
    const roleName = new Map<string, string>(defs.map((d: any) => [String(d.id), String(d.properties?.roleName ?? 'custom')]));
    // Group role assignments per principal.
    const byPrincipal = new Map<string, { roles: string[]; type: string }>();
    for (const a of assigns) {
      const pid = String(a.properties?.principalId ?? '');
      if (!pid) continue;
      const cur = byPrincipal.get(pid) ?? { roles: [], type: String(a.properties?.principalType ?? 'User') };
      cur.roles.push(roleName.get(String(a.properties?.roleDefinitionId)) ?? 'custom');
      byPrincipal.set(pid, cur);
    }
    return [...byPrincipal.entries()].map(([pid, v]) => ({
      externalId: pid,
      name: pid.slice(0, 12),
      email: null, // needs Graph API; principals matched by id only
      kind: v.type === 'ServicePrincipal' ? 'serviceAccount' : v.type.toLowerCase(),
      permissions: v.roles,
      lastUsedAt: null,
    }));
  }

  private async ingestGcp(creds: Record<string, string>) {
    const { token, project } = await getGcpToken(creds as any);
    const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(project)}:getIamPolicy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error(`gcp getIamPolicy ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const policy = (await res.json()) as { bindings?: { role: string; members: string[] }[] };
    const byMember = new Map<string, string[]>();
    for (const b of policy.bindings ?? []) {
      for (const m of b.members ?? []) {
        const list = byMember.get(m) ?? [];
        list.push(b.role);
        byMember.set(m, list);
      }
    }
    return [...byMember.entries()].map(([member, roles]) => {
      const [kind, id] = member.split(':');
      return {
        externalId: member,
        name: id ?? member,
        email: id?.includes('@') ? id : null,
        kind: kind === 'serviceAccount' ? 'serviceAccount' : kind === 'group' ? 'group' : 'user',
        permissions: roles,
        lastUsedAt: null,
      };
    });
  }

  // ── Findings (6.4) + cross-cloud consistency (6.3) ────────────────────────

  async findings(source?: 'cloud' | 'sandbox'): Promise<{ findings: CiemFinding[]; identities: number }> {
    const identities = await this.prisma.cloudIdentity.findMany({ where: source ? { source } : {} });
    const findings: CiemFinding[] = [];
    const now = Date.now();

    for (const it of identities) {
      const perms = Array.isArray(it.permissions) ? (it.permissions as string[]) : [];
      const unused = it.lastUsedAt === null || now - it.lastUsedAt.getTime() > UNUSED_DAYS * 86400_000;
      if (it.privilege === 'admin' || perms.some((p) => /\*/.test(p))) {
        findings.push({
          identityId: it.id, provider: String(it.provider), name: it.name, email: it.email, kind: it.kind,
          category: 'over-provisioned',
          detail: `${it.privilege} tier via [${perms.slice(0, 3).join(', ')}]${unused ? ' and no observed use ≥90d' : ''} — apply least privilege`,
        });
      }
      if (unused && it.lastUsedAt !== null) {
        findings.push({
          identityId: it.id, provider: String(it.provider), name: it.name, email: it.email, kind: it.kind,
          category: 'unused',
          detail: `no observed use since ${it.lastUsedAt.toISOString().slice(0, 10)} (≥${UNUSED_DAYS}d) — disable or remove`,
        });
      }
    }

    // Drift: same email on ≥2 providers with different privilege tier.
    const byEmail = new Map<string, typeof identities>();
    for (const it of identities) {
      if (!it.email) continue;
      const list = byEmail.get(it.email.toLowerCase()) ?? [];
      list.push(it);
      byEmail.set(it.email.toLowerCase(), list);
    }
    for (const [email, list] of byEmail) {
      const providers = new Set(list.map((i) => String(i.provider)));
      if (providers.size < 2) continue;
      const tiers = new Set(list.map((i) => i.privilege));
      if (tiers.size > 1) {
        const spread = list.map((i) => `${i.provider}:${i.privilege}`).join(' vs ');
        for (const it of list) {
          findings.push({
            identityId: it.id, provider: String(it.provider), name: it.name, email, kind: it.kind,
            category: 'drift',
            detail: `same person holds different tiers across clouds (${spread}) — align to one policy`,
          });
        }
      }
    }
    return { findings, identities: identities.length };
  }

  /** 6.3: of identities present on ≥2 clouds, how many hold the SAME tier everywhere. */
  async consistency(source?: 'cloud' | 'sandbox') {
    const identities = await this.prisma.cloudIdentity.findMany({ where: source ? { source } : {} });
    const byEmail = new Map<string, { providers: Set<string>; tiers: Set<string> }>();
    for (const it of identities) {
      if (!it.email) continue;
      const cur = byEmail.get(it.email.toLowerCase()) ?? { providers: new Set(), tiers: new Set() };
      cur.providers.add(String(it.provider));
      cur.tiers.add(it.privilege);
      byEmail.set(it.email.toLowerCase(), cur);
    }
    const multi = [...byEmail.values()].filter((v) => v.providers.size >= 2);
    const consistent = multi.filter((v) => v.tiers.size === 1).length;
    return {
      multiCloudIdentities: multi.length,
      consistent,
      consistencyPct: multi.length ? r3(consistent / multi.length) : null,
      note: 'matched by email across providers; tier = classified privilege (admin/write/read/custom)',
    };
  }

  // ── Sandbox eval (the synopsis's governance boundary: never live IAM) ─────

  /**
   * Seeds labelled sandbox identities — planted over-provisioned, unused and
   * drifted cases among clean ones — runs detection, scores precision/recall
   * per category, persists the report, and removes the sandbox.
   */
  async runEval() {
    await this.prisma.cloudIdentity.deleteMany({ where: { source: 'sandbox' } });
    const old = new Date(Date.now() - 200 * 86400_000);
    const fresh = new Date(Date.now() - 5 * 86400_000);
    type Seed = { provider: 'aws' | 'azure' | 'gcp'; name: string; email?: string; permissions: string[]; lastUsedAt: Date | null; labels: ('over-provisioned' | 'unused' | 'drift')[] };
    const seeds: Seed[] = [
      // Planted over-provisioned (3): admin tier, stale or wildcard.
      { provider: 'aws', name: 'op-admin-stale', email: 'op-admin@corp.test', permissions: ['AdministratorAccess'], lastUsedAt: old, labels: ['over-provisioned', 'unused'] },
      { provider: 'azure', name: 'op-owner', email: 'owner@corp.test', permissions: ['Owner'], lastUsedAt: fresh, labels: ['over-provisioned'] },
      { provider: 'gcp', name: 'op-wildcard-sa', permissions: ['roles/owner', 'compute.*'], lastUsedAt: null, labels: ['over-provisioned'] },
      // Planted unused (2): read tier but dormant.
      { provider: 'aws', name: 'dormant-reader', email: 'dormant@corp.test', permissions: ['ReadOnlyAccess'], lastUsedAt: old, labels: ['unused'] },
      { provider: 'azure', name: 'dormant-viewer', permissions: ['Reader'], lastUsedAt: old, labels: ['unused'] },
      // Planted drift (1 person on 2 clouds with different tiers → 2 rows).
      { provider: 'aws', name: 'drift-user-aws', email: 'drift@corp.test', permissions: ['ReadOnlyAccess'], lastUsedAt: fresh, labels: ['drift'] },
      { provider: 'gcp', name: 'drift-user-gcp', email: 'drift@corp.test', permissions: ['roles/editor'], lastUsedAt: fresh, labels: ['drift'] },
      // Clean identities (5): correct least-privilege, active, consistent.
      { provider: 'aws', name: 'clean-dev-1', email: 'dev1@corp.test', permissions: ['AmazonEC2ReadOnlyAccess'], lastUsedAt: fresh, labels: [] },
      { provider: 'azure', name: 'clean-dev-1-az', email: 'dev1@corp.test', permissions: ['Reader'], lastUsedAt: fresh, labels: [] },
      { provider: 'gcp', name: 'clean-ops', email: 'ops@corp.test', permissions: ['roles/viewer'], lastUsedAt: fresh, labels: [] },
      { provider: 'azure', name: 'clean-svc', permissions: ['Storage Blob Data Reader'], lastUsedAt: fresh, labels: [] },
      { provider: 'gcp', name: 'clean-audit', email: 'audit@corp.test', permissions: ['roles/viewer'], lastUsedAt: fresh, labels: [] },
    ];

    const truth = new Map<string, Set<string>>(); // identity name → labelled categories
    for (const s of seeds) {
      await this.prisma.cloudIdentity.create({
        data: {
          provider: s.provider, externalId: `sandbox-${s.provider}-${s.name}`, name: s.name, email: s.email ?? null,
          kind: s.name.includes('sa') || s.name.includes('svc') ? 'serviceAccount' : 'user',
          permissions: s.permissions, privilege: classifyPrivilege(s.permissions), lastUsedAt: s.lastUsedAt, source: 'sandbox',
        },
      });
      truth.set(s.name, new Set(s.labels));
    }

    try {
      const { findings } = await this.findings('sandbox');
      const consistency = await this.consistency('sandbox');

      // Score per category: detected(name,cat) vs truth(name,cat).
      const detected = new Set(findings.map((f) => `${f.name}:${f.category}`));
      const expected = new Set<string>();
      for (const [name, cats] of truth) for (const c of cats) expected.add(`${name}:${c}`);
      const tp = [...expected].filter((k) => detected.has(k)).length;
      const fp = [...detected].filter((k) => !expected.has(k)).length;
      const fn = expected.size - tp;
      const report = {
        identities: seeds.length,
        planted: expected.size,
        detected: detected.size,
        precision: detected.size ? r3(tp / (tp + fp)) : null,
        recall: expected.size ? r3(tp / (tp + fn)) : null,
        consistency,
        verdict:
          fn === 0 && fp === 0
            ? 'PASS — every planted entitlement issue found, no false findings'
            : `PARTIAL — ${tp}/${expected.size} planted found, ${fp} false finding(s)`,
        findings: findings.map((f) => ({ name: f.name, provider: f.provider, category: f.category, detail: f.detail })),
        note: 'sandboxed identities only (synopsis governance boundary) — live IAM untouched',
      };
      await this.prisma.eventLog.create({ data: { type: 'system', severity: 'info', title: CIEM_TITLE, detail: JSON.stringify(report) } });
      this.log.log(`CIEM eval: ${report.verdict} (precision=${report.precision} recall=${report.recall})`);
      return report;
    } finally {
      await this.prisma.cloudIdentity.deleteMany({ where: { source: 'sandbox' } });
    }
  }

  async identities(source?: 'cloud' | 'sandbox') {
    return this.prisma.cloudIdentity.findMany({ where: source ? { source } : {}, orderBy: [{ provider: 'asc' }, { name: 'asc' }], take: 500 });
  }
}
