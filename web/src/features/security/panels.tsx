'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Card, LoadingState, Modal, ProviderBadge, SeverityBadge } from '@/components/ui';
import {
  useChannels,
  useCreateChannel,
  useUpdateChannel,
  useDeleteChannel,
  useTestChannel,
  useGroups,
  useRefreshFindings,
  useRunVapt,
  useVaptStatus,
  useVaptRules,
  useVaptAnalysis,
  useRemediation,
  useSecurity,
  useSecurityFindings,
  useAlertRules,
  useCreateRule,
  useDeleteRule,
  useUpdateRule,
  useDeleteWorkflow,
  useUpdateWorkflow,
  useWorkflows,
} from '@/lib/hooks';
import { WorkflowBuilder } from './WorkflowBuilder';
import type { Workflow } from '@/lib/types';
import type { NotificationChannel } from '@/lib/hooks';

const CMP_LABEL: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };
const PROVIDERS = ['', 'aws', 'azure', 'gcp', 'linux', 'windows'];
const RULE_METRIC_META: Record<string, { icon: string; label: string }> = {
  cpu: { icon: '🧮', label: 'CPU' }, memory: { icon: '🧠', label: 'Memory' }, disk: { icon: '💾', label: 'Disk' },
};
const CHANNEL_PLACEHOLDER: Record<string, string> = {
  slack: 'Slack incoming-webhook URL',
  webhook: 'https://hooks…',
  email: 'recipient@example.com',
  pagerduty: 'PagerDuty routing/integration key',
  whatsapp: 'recipient phone, e.g. 919876543210',
};

/**
 * Frame lets every panel render in two modes: the normal Card (on its own page) or `bare` (inside a
 * board cell, which already supplies the title + frame — so we drop the Card and float the actions).
 */
function Frame({ bare, title, action, bodyClassName, children }: { bare?: boolean; title: string; action?: ReactNode; bodyClassName?: string; children: ReactNode }) {
  if (bare) {
    return (
      <div className="flex h-full flex-col">
        {action && <div className="mb-2 flex flex-wrap items-center justify-end gap-2">{action}</div>}
        <div className={`min-h-0 flex-1 ${bodyClassName ?? ''}`}>{children}</div>
      </div>
    );
  }
  return <Card title={title} action={action} bodyClassName={bodyClassName}>{children}</Card>;
}

// ───────────────────────── Cloud Security Findings ─────────────────────────
export function FindingsPanel({ bare = false }: { bare?: boolean }) {
  const ov = useSecurity();
  const findings = useSecurityFindings();
  const refresh = useRefreshFindings();
  const vapt = useRunVapt();
  const aiAnalysis = useVaptAnalysis();
  const [aiOpen, setAiOpen] = useState(false);
  const [selFinding, setSelFinding] = useState<{ id: string; title: string; type: string; severity: string; provider: string; resourceName?: string | null; source?: string | null } | null>(null);
  const [scanning, setScanning] = useState(false);
  const status = useVaptStatus(scanning);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => { ov.refetch(); findings.refetch(); }, 5000);
    return () => clearInterval(t);
  }, [scanning, ov, findings]);
  useEffect(() => {
    if (scanning && status.data && status.data.scanning === false) setScanning(false);
  }, [scanning, status.data]);

  const run = async () => {
    setMsg(null);
    try {
      const r = await refresh.mutateAsync();
      setMsg(`Pulled ${r.total} finding(s): ${r.results.map((x: any) => `${x.provider}=${x.count ?? x.error ?? (x.supported === false ? 'n/a' : 0)}`).join(', ')}`);
    } catch (e) { setMsg((e as Error).message); }
  };
  const runVapt = async () => {
    setMsg(null);
    try {
      const r = await vapt.mutateAsync();
      setMsg(r.message);
      if (r.started) setScanning(true);
    } catch (e) { setMsg((e as Error).message); }
  };

  const k = ov.data?.kpis;
  const busy = scanning || vapt.isPending;
  const [fType, setFType] = useState<string>('');
  const [fProvider, setFProvider] = useState<string>('');
  const [showRules, setShowRules] = useState(false);
  const all = findings.data ?? [];
  const filtered = all.filter((f) => (!fType || f.type === fType) && (!fProvider || f.provider === fProvider));
  const clearable = !!(fType || fProvider);

  return (
    <Frame
      bare={bare}
      title="Cloud Security Findings"
      action={
        <div className="flex items-center gap-2">
          <button onClick={() => setShowRules((s) => !s)} className="rounded-md border border-border bg-card px-3 py-1 text-2xs font-medium text-brand hover:text-white" title="What an external VAPT scan checks and how to comply">{showRules ? 'Hide scan coverage' : '🔍 Scan coverage & process'}</button>
          <button onClick={runVapt} disabled={busy} className="rounded-md border border-danger/50 bg-danger/10 px-3 py-1 text-2xs font-medium text-danger hover:bg-danger/20 disabled:opacity-50" title="Open-source Nmap external VAPT of every enrolled VM">
            {busy ? '◌ Scanning VMs…' : '🛰 External VAPT scan'}
          </button>
          <button onClick={() => { setAiOpen(true); aiAnalysis.mutate(); }} disabled={aiAnalysis.isPending} className="rounded-md border border-purple/50 bg-purple/10 px-3 py-1 text-2xs font-medium text-purple hover:bg-purple/20 disabled:opacity-50" title="AI analysis of the current findings: prioritised risk, attack paths & remediation" style={{ borderColor: '#a855f766', color: '#c084fc' }}>
            {aiAnalysis.isPending ? '◌ Analyzing…' : '🧠 AI Analysis'}
          </button>
          <button onClick={run} disabled={refresh.isPending} className="rounded-md bg-brand px-3 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">
            {refresh.isPending ? 'Refreshing…' : 'Refresh findings'}
          </button>
        </div>
      }
    >
      {showRules && <VaptCoverage />}
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Mini label="Vulnerabilities" value={k?.openVulnerabilities ?? 0} color="#ef4444" active={fType === 'vulnerability'} onClick={() => setFType(fType === 'vulnerability' ? '' : 'vulnerability')} />
        <Mini label="Misconfigurations" value={k?.misconfigurations ?? 0} color="#f59e0b" active={fType === 'misconfiguration'} onClick={() => setFType(fType === 'misconfiguration' ? '' : 'misconfiguration')} />
        <Mini label="Threats" value={k?.threatDetections ?? 0} color="#a855f7" active={fType === 'threat'} onClick={() => setFType(fType === 'threat' ? '' : 'threat')} />
      </div>
      {ov.data && ov.data.findingsByProvider.some((p) => p.total > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {ov.data.findingsByProvider.filter((p) => p.total > 0).map((p) => (
            <button key={p.provider} onClick={() => setFProvider(fProvider === p.provider ? '' : p.provider)} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-2xs transition ${fProvider === p.provider ? 'border-brand bg-brand/15' : 'border-border bg-card hover:border-brand/50'}`}>
              <ProviderBadge provider={p.provider} /> <span className="text-white">{p.total}</span>
            </button>
          ))}
          {clearable && <button onClick={() => { setFType(''); setFProvider(''); }} className="ml-auto rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted hover:text-white">✕ Clear filter</button>}
        </div>
      )}
      {findings.isLoading ? (
        <LoadingState rows={2} />
      ) : all.length === 0 ? (
        <div className="rounded-lg border border-border bg-card-hover/30 p-4 text-2xs text-muted-light">
          No findings yet. Click <b className="text-white">🛰 External VAPT scan</b> for an open-source <b className="text-white">Nmap</b> assessment of every enrolled VM, or <b className="text-white">Refresh findings</b> to pull cloud-native posture from Defender, Security Hub and SCC.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-card-hover/30 p-4 text-center text-2xs text-muted-light">No {fType || ''} findings{fProvider ? ` for ${fProvider}` : ''}. <button onClick={() => { setFType(''); setFProvider(''); }} className="text-brand hover:underline">Clear filter</button></div>
      ) : (
        <>
          <div className="mb-1 text-2xs text-muted">Showing {filtered.length} of {all.length}{clearable ? ' (filtered)' : ''}</div>
          <div className="max-h-80 divide-y divide-border-soft overflow-y-auto rounded-lg border border-border">
            {filtered.slice(0, 200).map((f) => (
              <button key={f.id} onClick={() => setSelFinding(f as never)} title="How to fix this finding" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition hover:bg-card-hover">
                <div className="min-w-0">
                  <div className="truncate text-white">{f.title}</div>
                  <div className="text-2xs text-muted capitalize">{f.type} · {f.resourceName ?? '—'} · {f.source ?? ''}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ProviderBadge provider={f.provider} />
                  <SeverityBadge severity={f.severity} />
                  <span className="text-2xs text-muted">🔧</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      {msg && <div className="mt-2 rounded-lg border border-border bg-bg/40 px-3 py-1.5 text-2xs text-muted-light">{msg}</div>}

      {aiOpen && (
        <Modal wide onClose={() => setAiOpen(false)} title="🧠 AI VAPT Analysis">
          {aiAnalysis.isPending ? (
            <div className="py-8 text-center text-2xs text-muted">Analyzing findings with the AI engine… (first run can take ~1–2 min on a cold model)</div>
          ) : aiAnalysis.isError ? (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-3 text-2xs text-danger">Analysis failed: {(aiAnalysis.error as Error)?.message ?? 'unknown error'}. Make sure findings exist (run a scan) and retry.</div>
          ) : aiAnalysis.data ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
                <span className="rounded bg-card px-1.5 py-0.5 text-white">{aiAnalysis.data.count} findings analyzed</span>
                {Object.entries(aiAnalysis.data.bySeverity).map(([s, n]) => <span key={s} className="rounded bg-card px-1.5 py-0.5 capitalize">{s}: {n}</span>)}
                <span className="ml-auto">{aiAnalysis.data.source === 'llm' ? `via ${aiAnalysis.data.model}` : aiAnalysis.data.source === 'local' ? `via ${aiAnalysis.data.model}` : 'native engine'}</span>
              </div>
              {aiAnalysis.data.note && <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-2xs text-warning">{aiAnalysis.data.note}</div>}
              <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg/40 p-3 text-2xs leading-relaxed text-muted-light">{aiAnalysis.data.analysis}</div>
              <div className="text-2xs text-muted">Grounded in your current findings — detection is by Nmap/cloud-native scanners; this is the AI analyst layer. Not a substitute for manual penetration testing.</div>
            </div>
          ) : null}
        </Modal>
      )}

      {selFinding && <FixModal finding={selFinding} onClose={() => setSelFinding(null)} />}
    </Frame>
  );
}

// ── Per-finding remediation: instant deterministic guidance keyed by the finding, + an AI deep-dive ──
function remediationFor(f: { title: string; type: string; provider: string }): { why: string; steps: string[] } {
  const s = `${f.title}`.toLowerCase();
  const m = (re: RegExp) => re.test(s);
  if (m(/\brdp\b|3389|remote desktop/)) return { why: 'Remote Desktop reachable from the internet is a top ransomware/brute-force entry point.', steps: ['Restrict TCP 3389 in the cloud NSG/security-group to your VPN/jump-host CIDR only (remove 0.0.0.0/0).', 'Enable Network Level Authentication (NLA) and enforce MFA for RDP.', 'Prefer a bastion / Azure Bastion / SSM Session Manager instead of public RDP.', 'Block 3389 at the OS firewall as defence-in-depth.'] };
  if (m(/\bssh\b|\bport 22\b|\b22\/tcp\b/)) return { why: 'Open SSH to the internet invites brute-force and credential attacks.', steps: ['Scope TCP 22 in the NSG/security-group to a bastion/VPN CIDR.', 'Disable password auth — key-only (PasswordAuthentication no); enable fail2ban.', 'Use a bastion / SSM Session Manager rather than a public SSH port.'] };
  if (m(/mssql|mysql|postgres|mongo|redis|1433|3306|5432|27017|6379|database port/)) return { why: 'A database reachable from the internet risks data theft and ransomware.', steps: ['Remove any public ingress to the DB port; restrict to the app subnet/security-group only.', 'Require authentication + TLS in transit; rotate credentials.', 'Place the DB in a private subnet with no public IP.'] };
  if (m(/tls|ssl|cipher/)) return { why: 'Legacy TLS/SSL and weak ciphers allow downgrade/MITM attacks.', steps: ['Disable SSLv2/SSLv3 and TLS 1.0/1.1; enforce TLS 1.2+ (ideally 1.3).', 'Remove weak ciphers (RC4, 3DES, export); prefer AEAD suites.', 'Renew/replace expired or weak certificates.'] };
  if (m(/ftp|anonymous/)) return { why: 'Anonymous/plaintext FTP exposes data and credentials.', steps: ['Disable anonymous FTP login.', 'Replace FTP with SFTP/FTPS; restrict source IPs.'] };
  if (m(/encrypt/)) return { why: 'Unencrypted disks leave data readable if storage is compromised.', steps: ['Enable disk encryption — Azure Disk Encryption / EncryptionAtHost, AWS EBS encryption, or GCP CMEK.', 'Confirm boot + data volumes are covered; rotate keys via KMS/Key Vault.'] };
  if (m(/network security group|nsg|security group|all network ports|internet-facing|firewall|exposed|public/)) return { why: 'Over-permissive network exposure widens the attack surface.', steps: ['Attach an NSG/security-group and default-deny inbound.', 'Allow only required ports from specific CIDRs; remove 0.0.0.0/0 rules.', 'Remove unnecessary public IPs; use private endpoints.'] };
  if (m(/cve|vulner/)) return { why: 'A known CVE in a running service can be exploited directly.', steps: ['Patch/upgrade the affected service to the fixed version.', 'If immediate patching is impossible, restrict network access and add compensating controls.', 'Subscribe to the vendor advisory and enable auto-patching.'] };
  if (m(/mfa|multi-?factor/)) return { why: 'Accounts without MFA are vulnerable to credential theft.', steps: ['Enforce MFA for all users (Conditional Access / IAM policy).', 'Disable legacy auth that bypasses MFA.'] };
  if (m(/update|patch|out of date/)) return { why: 'Missing OS/security updates leave known holes open.', steps: ['Apply pending OS and security updates.', 'Enable automatic/managed patching.'] };
  const byType: Record<string, { why: string; steps: string[] }> = {
    vulnerability: { why: 'A vulnerability can be exploited to compromise the resource.', steps: ['Patch to the fixed version; restrict access until patched.', 'Re-scan to confirm the finding clears.'] },
    misconfiguration: { why: 'A misconfiguration weakens the resource’s security posture.', steps: ['Apply the secure setting indicated by the finding title.', 'Restrict network exposure and re-evaluate.'] },
    threat: { why: 'An active threat indicator needs investigation and containment.', steps: ['Investigate the affected resource; isolate if compromise is suspected.', 'Review logs/SIEM around the detection time and remediate the root cause.'] },
  };
  return byType[f.type] ?? { why: 'Review this finding against your security baseline.', steps: ['Open the resource, apply the fix the finding describes, and re-scan to verify.'] };
}

function FixModal({ finding, onClose }: { finding: { id: string; title: string; type: string; severity: string; provider: string; resourceName?: string | null }; onClose: () => void }) {
  const ai = useRemediation();
  const rec = remediationFor(finding);
  return (
    <Modal wide onClose={onClose} title="🔧 How to fix">
      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center gap-2"><SeverityBadge severity={finding.severity as never} /><ProviderBadge provider={finding.provider as never} /><span className="text-2xs capitalize text-muted">{finding.type}{finding.resourceName ? ` · ${finding.resourceName}` : ''}</span></div>
          <div className="text-sm font-medium text-white">{finding.title}</div>
        </div>

        <div className="rounded-lg border border-border bg-bg/40 p-3">
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted">Why it matters</div>
          <div className="mt-0.5 text-2xs text-muted-light">{rec.why}</div>
          <div className="mt-2 text-2xs font-semibold uppercase tracking-wide text-muted">Recommended fix</div>
          <ol className="ml-4 mt-0.5 list-decimal space-y-1 text-2xs text-muted-light">{rec.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
        </div>

        <div>
          <button onClick={() => ai.mutate({ title: finding.title, type: finding.type, provider: finding.provider, resourceName: finding.resourceName ?? undefined })} disabled={ai.isPending} className="rounded-md border px-3 py-1 text-2xs font-medium disabled:opacity-50" style={{ borderColor: '#a855f766', color: '#c084fc' }}>
            {ai.isPending ? '◌ Asking the AI…' : '🧠 AI deep-dive for this finding'}
          </button>
          {ai.data && <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-bg/40 p-3 text-2xs leading-relaxed text-muted-light">{ai.data.steps}{ai.data.note ? `\n\n(${ai.data.note})` : ''}</div>}
          {ai.isError && <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">AI deep-dive failed — the built-in fix above still applies. Retry shortly.</div>}
        </div>
      </div>
    </Modal>
  );
}

function VaptCoverage() {
  const { data } = useVaptRules();
  const TYPE_COLOR: Record<string, string> = { vulnerability: '#ef4444', misconfiguration: '#f59e0b', threat: '#a855f7' };
  if (!data) return <div className="mb-3 rounded-lg border border-border bg-bg/40 p-3 text-2xs text-muted">Loading scan coverage…</div>;
  return (
    <div className="mb-3 space-y-3 rounded-lg border border-brand/25 bg-brand/5 p-3">
      <div>
        <div className="text-2xs font-semibold uppercase tracking-wide text-brand">How the scan works</div>
        <div className="mt-0.5 text-2xs text-muted-light">{data.method}</div>
      </div>
      <div>
        <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-brand">Compliance process</div>
        <ol className="ml-4 list-decimal space-y-0.5 text-2xs text-muted-light">{data.process.map((s, i) => <li key={i}>{s}</li>)}</ol>
      </div>
      <div>
        <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-brand">Rules scanned ({data.rules.length})</div>
        <div className="max-h-56 overflow-auto rounded-lg border border-border">
          <table className="w-full text-2xs">
            <thead className="sticky top-0 bg-card text-left text-muted"><tr><th className="px-2 py-1 font-medium">Check</th><th className="px-2 py-1 font-medium">Category</th><th className="px-2 py-1 font-medium">Severity</th><th className="px-2 py-1 font-medium">What / how to remediate</th></tr></thead>
            <tbody>
              {data.rules.map((r, i) => (
                <tr key={i} className="border-t border-border-soft">
                  <td className="px-2 py-1 text-white">{r.check}</td>
                  <td className="px-2 py-1"><span className="rounded px-1.5" style={{ background: `${TYPE_COLOR[r.type] ?? '#64748b'}22`, color: TYPE_COLOR[r.type] ?? '#94a3b8' }}>{r.type}</span></td>
                  <td className="px-2 py-1 capitalize text-muted-light">{r.severity}</td>
                  <td className="px-2 py-1 text-muted">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value, color, active, onClick }: { label: string; value: number; color: string; active?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} className={`rounded-lg border p-3 text-center transition ${active ? 'border-brand bg-brand/10' : 'border-border bg-card-hover/30 hover:border-brand/50'}`}>
      <div className="text-lg font-semibold" style={{ color }}>{value}</div>
      <div className="text-2xs text-muted">{label}{active ? ' ·  filtered' : ''}</div>
    </button>
  );
}

// ───────────────────────── Alert Rules ─────────────────────────
type AlertRuleItem = { id: string; name: string; metric: string; comparator: string; threshold: number; severity: string; scopeProvider: string | null; enabled: boolean };

export function RulesPanel({ bare = false }: { bare?: boolean }) {
  const rules = useAlertRules();
  const update = useUpdateRule();
  const del = useDeleteRule();
  const [form, setForm] = useState<{ rule: AlertRuleItem | null } | null>(null);

  return (
    <Frame
      bare={bare}
      title={`Alert Rules (${rules.data?.length ?? 0})`}
      bodyClassName="p-0"
      action={<button onClick={() => setForm({ rule: null })} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ Add Rule</button>}
    >
      <div className="divide-y divide-border-soft">
        {rules.data?.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card text-lg">🔔</span>
            <div className="text-sm font-medium text-white">No alert rules yet</div>
            <div className="text-2xs text-muted">The engine evaluates rules on live metrics every minute.</div>
            <button onClick={() => setForm({ rule: null })} className="mt-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ Add your first rule</button>
          </div>
        )}
        {rules.data?.map((r) => {
          const m = RULE_METRIC_META[r.metric] ?? { icon: '📊', label: r.metric };
          return (
            <div key={r.id} className={`group flex items-center gap-3 px-4 py-3 transition hover:bg-card-hover ${r.enabled ? '' : 'opacity-60'}`}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-base">{m.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-white">{r.name}</span>
                  {!r.enabled && <span className="shrink-0 rounded bg-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">paused</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
                  <span className="rounded-md border border-border-soft bg-bg px-1.5 py-0.5 font-mono text-muted-light">{m.label} {CMP_LABEL[r.comparator]} {r.threshold}%</span>
                  <span>·</span>
                  <span>{r.scopeProvider ? r.scopeProvider.toUpperCase() : 'All providers'}</span>
                </div>
              </div>
              <SeverityBadge severity={r.severity} />
              <Toggle on={r.enabled} onClick={() => update.mutate({ id: r.id, enabled: !r.enabled })} />
              <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
                <button onClick={() => setForm({ rule: r })} title="Edit rule" className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-brand hover:text-white">✎</button>
                <button onClick={() => confirm(`Delete alert rule “${r.name}”?`) && del.mutate(r.id)} title="Delete rule" className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted hover:border-danger/50 hover:text-danger">✕</button>
              </div>
            </div>
          );
        })}
      </div>
      {form && <RuleFormModal rule={form.rule} onClose={() => setForm(null)} />}
    </Frame>
  );
}

function RuleFormModal({ rule, onClose }: { rule: AlertRuleItem | null; onClose: () => void }) {
  const create = useCreateRule();
  const update = useUpdateRule();
  const isEdit = !!rule;
  const [f, setF] = useState({
    name: rule?.name ?? '', metric: rule?.metric ?? 'cpu', comparator: rule?.comparator ?? 'gt',
    threshold: rule?.threshold ?? 85, severity: rule?.severity ?? 'high', scopeProvider: rule?.scopeProvider ?? '',
  });
  const busy = create.isPending || update.isPending;
  const save = async () => {
    if (!f.name.trim()) return;
    const body = { name: f.name.trim(), metric: f.metric, comparator: f.comparator, threshold: Number(f.threshold), severity: f.severity, scopeProvider: f.scopeProvider || null };
    if (isEdit) await update.mutateAsync({ id: rule!.id, ...body });
    else await create.mutateAsync(body);
    onClose();
  };
  return (
    <Modal title={isEdit ? 'Edit Alert Rule' : 'Add Alert Rule'} subtitle="Threshold evaluated on live metrics every minute" onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Rule name</span>
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. High CPU on production" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </label>
        <div className="grid grid-cols-3 gap-3">
          <label className="block"><span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Metric</span><Select value={f.metric} onChange={(v) => setF({ ...f, metric: v })} options={[['cpu', 'CPU %'], ['memory', 'Memory %'], ['disk', 'Disk %']]} /></label>
          <label className="block"><span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Condition</span><Select value={f.comparator} onChange={(v) => setF({ ...f, comparator: v })} options={[['gt', '> greater'], ['gte', '≥'], ['lt', '< less'], ['lte', '≤']]} /></label>
          <label className="block"><span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Threshold %</span><input type="number" value={f.threshold} onChange={(e) => setF({ ...f, threshold: Number(e.target.value) })} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none" /></label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Severity</span><Select value={f.severity} onChange={(v) => setF({ ...f, severity: v })} options={[['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]} /></label>
          <label className="block"><span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Applies to</span><Select value={f.scopeProvider} onChange={(v) => setF({ ...f, scopeProvider: v })} options={PROVIDERS.map((p) => [p, p ? p.toUpperCase() : 'All providers'])} /></label>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={save} disabled={busy || !f.name.trim()} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add rule'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── Automation + Delivery Channels ─────────────────────────
const WF_ACTION_META: Record<string, { icon: string; color: string; label: string }> = {
  notify: { icon: '🔔', color: '#3b82f6', label: 'Notify' },
  webhook: { icon: '🔗', color: '#06b6d4', label: 'Webhook' },
  stop_vm: { icon: '⏹', color: '#ef4444', label: 'Stop VM' },
  restart_vm: { icon: '🔁', color: '#f59e0b', label: 'Restart VM' },
};
const CHANNEL_META: Record<string, { icon: string; color: string }> = {
  slack: { icon: '💬', color: '#e01e5a' },
  webhook: { icon: '🔗', color: '#06b6d4' },
  email: { icon: '✉️', color: '#3b82f6' },
  pagerduty: { icon: '📟', color: '#22c55e' },
  whatsapp: { icon: '🟢', color: '#25d366' },
  group: { icon: '👥', color: '#a855f7' },
};
const inputCls = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none';

function IconTile({ icon, color }: { icon: string; color: string }) {
  return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base" style={{ background: `${color}1f`, color }}>{icon}</span>;
}
function Pill({ children, color }: { children: ReactNode; color?: string }) {
  if (color) return <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium" style={{ background: `${color}1f`, color }}>{children}</span>;
  return <span className="inline-flex items-center gap-1 rounded bg-card-hover px-1.5 py-0.5 text-2xs font-medium text-muted-light">{children}</span>;
}
function IconBtn({ onClick, title, danger, children, disabled }: { onClick: () => void; title: string; danger?: boolean; children: ReactNode; disabled?: boolean }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled} className={`flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card text-2xs transition hover:bg-card-hover disabled:opacity-40 ${danger ? 'text-danger hover:border-danger/40' : 'text-muted-light hover:text-white'}`}>{children}</button>
  );
}
function EmptyState({ icon, text, onAdd, addLabel }: { icon: string; text: string; onAdd: () => void; addLabel: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <div className="text-2xl opacity-40">{icon}</div>
      <div className="text-2xs text-muted">{text}</div>
      <button onClick={onAdd} className="rounded-md border border-brand/40 bg-brand/10 px-3 py-1 text-2xs font-medium text-brand hover:bg-brand/20">{addLabel}</button>
    </div>
  );
}
function AddToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`rounded-md px-2.5 py-1 text-2xs font-medium transition ${open ? 'border border-border bg-card text-muted hover:text-white' : 'bg-brand text-white hover:bg-brand-soft'}`}>{open ? 'Close' : '+ New'}</button>;
}
function Select({ value, onChange, options, className = '' }: { value: string; onChange: (v: string) => void; options: [string, string][]; className?: string }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)} className={`rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white focus:border-brand focus:outline-none ${className}`}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
}
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`relative h-4 w-7 rounded-full transition ${on ? 'bg-brand' : 'bg-border'}`}><span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? 'left-3.5' : 'left-0.5'}`} /></button>;
}

/** Automation workflows (trigger → actions → escalation). Delivery Channels is its own widget below. */
export function AutomationPanel({ bare = false }: { bare?: boolean }) {
  const wfs = useWorkflows();
  const update = useUpdateWorkflow();
  const del = useDeleteWorkflow();
  const [builder, setBuilder] = useState<{ initial: Workflow | null } | null>(null);

  return (
    <>
      {builder && <WorkflowBuilder initial={builder.initial} onClose={() => setBuilder(null)} />}
      <Frame
        bare={bare}
        title="Automation"
        bodyClassName="p-0"
        action={<button onClick={() => setBuilder({ initial: null })} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">+ New automation</button>}
      >
        <div className="border-b border-border bg-brand/[0.03] px-4 py-2 text-2xs text-muted">
          One rule, end-to-end: <b className="text-white">When</b> an alert matches → <b className="text-white">Then</b> run ordered actions → <b className="text-white">Escalate</b> with timed tiers. Notify steps deliver through the <b className="text-white">Delivery Channels</b> widget.
        </div>
        <div className="divide-y divide-border-soft">
          {wfs.data?.length === 0 && <EmptyState icon="⚡" text="No automations yet." onAdd={() => setBuilder({ initial: null })} addLabel="+ Create automation" />}
          {wfs.data?.map((w) => {
            const on = w.status === 'enabled';
            const stepCount = w.steps?.length ?? 0;
            const tiers = w.escalation?.length ?? 0;
            const meta = WF_ACTION_META[w.actionType] ?? { icon: '⚡', color: '#22c55e', label: w.actionType };
            return (
              <div key={w.id} className="flex items-center gap-3 px-3 py-2.5">
                <IconTile icon="⚡" color={on ? '#22c55e' : '#64748b'} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-semibold text-white">{w.name}</span>
                    {!on && <Pill>paused</Pill>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Pill color="#3b82f6">⚑ {w.trigger}</Pill>
                    {(w.conditions?.length ?? 0) > 0 && <Pill color="#3b82f6">+{w.conditions!.length} cond</Pill>}
                    <span className="text-2xs text-muted">→</span>
                    <Pill color="#22c55e">{stepCount > 0 ? `${stepCount} action${stepCount > 1 ? 's' : ''}` : `${meta.icon} ${meta.label}`}</Pill>
                    {tiers > 0 && <Pill color="#a855f7">⏱ {tiers} escalation tier{tiers > 1 ? 's' : ''}</Pill>}
                    <span className="text-2xs text-muted">· {w.runs} runs</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Toggle on={on} onClick={() => update.mutate({ id: w.id, enabled: !on })} />
                  <IconBtn onClick={() => setBuilder({ initial: w })} title="Edit automation">✎</IconBtn>
                  <IconBtn onClick={() => del.mutate(w.id)} title="Delete automation" danger>✕</IconBtn>
                </div>
              </div>
            );
          })}
        </div>
      </Frame>
    </>
  );
}

export function DeliveryChannelsPanel({ bare = false }: { bare?: boolean }) {
  const channels = useChannels();
  const create = useCreateChannel();
  const update = useUpdateChannel();
  const del = useDeleteChannel();
  const test = useTestChannel();
  const groups = useGroups();
  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name ?? id;
  const emptyF = { name: '', type: 'slack', target: '' };
  const [f, setF] = useState(emptyF);
  const [result, setResult] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const runTest = async (id: string) => {
    setResult(null);
    try {
      const r = await test.mutateAsync(id);
      setResult({ id, ok: r.ok, text: r.ok ? (r.error ?? 'Test delivered ✓') : `Failed: ${r.error}` });
    } catch (e) { setResult({ id, ok: false, text: (e as Error).message }); }
  };
  const openNew = () => { setEditId(null); setF(emptyF); setAdding(true); };
  const startEdit = (c: NotificationChannel) => { setEditId(c.id); setF({ name: c.name, type: c.type, target: c.target }); setAdding(true); };
  const close = () => { setAdding(false); setEditId(null); };
  const submit = () => {
    if (!f.name || !f.target) return;
    if (editId) update.mutate({ id: editId, ...f });
    else create.mutate({ ...f });
    close();
  };

  return (
    <Frame bare={bare} title="Delivery Channels" bodyClassName="p-0" action={<AddToggle open={adding} onClick={() => (adding ? close() : openNew())} />}>
      {adding && (
        <div className="space-y-2 border-b border-border bg-brand/[0.04] p-3">
          {editId && <div className="text-2xs font-semibold text-brand">✎ Editing channel</div>}
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Channel name" className={inputCls} />
          <div className="flex flex-wrap gap-2">
            <Select className="min-w-[130px] flex-1" value={f.type} onChange={(v) => setF({ ...f, type: v, target: '' })} options={[['slack', 'Slack'], ['webhook', 'Webhook'], ['email', 'Email'], ['pagerduty', 'PagerDuty'], ['whatsapp', 'WhatsApp'], ['group', 'Group / Team']]} />
            {f.type === 'group' ? (
              <select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} className="min-w-[160px] flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none">
                <option value="">Select a group…</option>
                {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>)}
              </select>
            ) : (
              <input value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder={CHANNEL_PLACEHOLDER[f.type] ?? 'https://hooks…'} className={`${inputCls} min-w-[160px] flex-1`} />
            )}
          </div>
          <button onClick={submit} disabled={create.isPending || update.isPending || !f.name || !f.target} className="w-full rounded-md bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{editId ? 'Save changes' : create.isPending ? 'Adding…' : '+ Add channel'}</button>
          <div className="text-2xs text-muted">Workflows with the <b className="text-white">Notify</b> action deliver to all enabled channels. See <b className="text-white">Help → Platform Integrations</b>.</div>
        </div>
      )}
      <div className="divide-y divide-border-soft">
        {channels.data?.length === 0 && !adding && <EmptyState icon="📡" text="No notification channels yet." onAdd={openNew} addLabel="+ Add channel" />}
        {channels.data?.map((c) => {
          const meta = CHANNEL_META[c.type] ?? { icon: '🔗', color: '#06b6d4' };
          return (
            <div key={c.id} className="px-3 py-2.5">
              <div className="flex items-center gap-3">
                <IconTile icon={meta.icon} color={meta.color} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-semibold text-white">{c.name}</span>
                    <Pill color={meta.color}>{c.type}</Pill>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-2xs text-muted">{c.type === 'group' ? `👥 ${groupName(c.target)}` : c.target}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button onClick={() => runTest(c.id)} disabled={test.isPending} className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-brand hover:bg-card-hover hover:text-white disabled:opacity-50">Test</button>
                  <IconBtn onClick={() => startEdit(c)} title="Edit channel">✎</IconBtn>
                  <IconBtn onClick={() => del.mutate(c.id)} title="Delete channel" danger>✕</IconBtn>
                </div>
              </div>
              {result?.id === c.id && (
                <div className={`ml-12 mt-1.5 rounded border px-2 py-1 text-2xs ${result.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>{result.text}</div>
              )}
            </div>
          );
        })}
      </div>
    </Frame>
  );
}
