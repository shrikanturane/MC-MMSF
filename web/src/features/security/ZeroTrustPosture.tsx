'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, Modal } from '@/components/ui';
import { useZeroTrust, useZtRemediate, useZtWorkloads } from '@/lib/hooks';
import { useAuthUser } from '@/lib/auth';
import { timeAgo } from '@/lib/format';

const STATUS_COLOR: Record<string, string> = { ok: '#22c55e', warn: '#f59e0b', fail: '#ef4444' };
const scoreColor = (s: number) => (s >= 85 ? '#22c55e' : s >= 65 ? '#84cc16' : s >= 40 ? '#f59e0b' : '#ef4444');

type ZtCheck = { label: string; detail?: string; status: string };
type ZtPillar = { key: string; name: string; icon: string; score: number; checks: ZtCheck[] };

/** Per-pillar remediation guidance: where to change rules / fix, and the module that governs it. */
function pillarGuide(name: string): { where: string; to: string; toLabel: string } {
  const n = name.toLowerCase();
  if (n.includes('identity') || n.includes('user')) return { where: 'Enforce MFA for every user, apply least-privilege roles, and remove stale accounts.', to: '/settings?section=access', toLabel: 'Access & Users' };
  if (n.includes('device') || n.includes('endpoint')) return { where: 'Install the MCMF endpoint agent on every host and bring firewall / AV / disk-encryption posture to green.', to: '/command-center', toLabel: 'Command Center' };
  if (n.includes('network')) return { where: 'Open Network → Analysis & Exposure → “Scan firewall rules”, then click the Critical + High tile to list the admin-port (SSH/RDP) and “allow-all” rules. For each, restrict the source from 0.0.0.0/0 to your admin CIDR (or click Remediate) in the cloud NSG / security-group, then re-scan.', to: '/network', toLabel: 'Network → Analysis & Exposure' };
  if (n.includes('workload') || n.includes('application')) return { where: 'Patch open CVEs, restrict inbound rules, and run workloads under least-privilege service accounts.', to: '/vms', toLabel: 'VMs / Workloads' };
  if (n.includes('data')) return { where: 'Encrypt data at rest and in transit, remove public access from datastores, and classify sensitive data.', to: '/inventory', toLabel: 'Inventory / Data' };
  if (n.includes('visib') || n.includes('analytic') || n.includes('monitor')) return { where: 'Centralize logs, alerts and the audit trail; review the SIEM stream regularly.', to: '/activity', toLabel: 'Activity & Events' };
  if (n.includes('automation') || n.includes('orchestr')) return { where: 'Codify response in automation workflows and approval policies.', to: '/command-center', toLabel: 'Command Center' };
  return { where: 'Review the failing checks below and remediate at the source.', to: '/security', toLabel: 'Security' };
}

/** Zero-Trust posture scorecard — never trust, always verify. Scored from real signals. */
export function ZeroTrustPosture({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useZeroTrust();
  const { data: me } = useAuthUser();
  const remediate = useZtRemediate();
  const [remMsg, setRemMsg] = useState<string | null>(null);
  const [openPillar, setOpenPillar] = useState<ZtPillar | null>(null);
  const isAdmin = me?.role === 'admin';
  const doRemediate = async () => {
    setRemMsg('Remediating network exposures…');
    try { const r = await remediate.mutateAsync('network'); setRemMsg(`Remediated ${r.results.filter((x) => !/failed/.test(x.detail)).length}/${r.attempted} exposure(s).`); }
    catch (e) { setRemMsg((e as Error).message); }
  };
  if (isLoading || !data) return null;
  const c = scoreColor(data.score);
  const r = 52, circ = 2 * Math.PI * r;

  const body = (
    <>
      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Overall score ring + maturity */}
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card/50 p-4">
          <svg viewBox="0 0 130 130" className="h-32 w-32">
            <circle cx="65" cy="65" r={r} fill="none" stroke="#1f2937" strokeWidth="10" />
            <circle cx="65" cy="65" r={r} fill="none" stroke={c} strokeWidth="10" strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={circ * (1 - data.score / 100)} transform="rotate(-90 65 65)" />
            <text x="65" y="60" textAnchor="middle" fontSize="26" fontWeight="700" fill="#fff">{data.score}</text>
            <text x="65" y="80" textAnchor="middle" fontSize="9" fill="#8b95a3">/ 100</text>
          </svg>
          <div className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: `${c}22`, color: c }}>{data.maturity}</div>
          <div className="text-2xs text-muted">CISA ZT maturity</div>
        </div>

        {/* Pillars */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {data.pillars.map((p) => (
            <button key={p.key} onClick={() => setOpenPillar(p as ZtPillar)} title={`Remediate ${p.name} to 100%`} className="group rounded-xl border border-border bg-card/50 p-3 text-left transition hover:border-brand/50 hover:bg-card-hover">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-white"><span>{p.icon}</span>{p.name}<span className="text-2xs text-muted opacity-0 transition group-hover:opacity-100">remediate →</span></span>
                <span className="text-sm font-bold" style={{ color: scoreColor(p.score) }}>{p.score}</span>
              </div>
              <div className="mb-2 h-1.5 w-full rounded-full bg-border"><div className="h-1.5 rounded-full" style={{ width: `${p.score}%`, background: scoreColor(p.score) }} /></div>
              <ul className="space-y-0.5">
                {p.checks.map((ch, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-2xs text-muted-light">
                    <span style={{ color: STATUS_COLOR[ch.status] }}>{ch.status === 'ok' ? '✓' : ch.status === 'warn' ? '▲' : '✕'}</span>
                    <span className="flex-1">{ch.label} <span className="text-muted">{ch.detail}</span></span>
                  </li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      </div>

      {/* Prioritized recommendations */}
      {data.recommendations.length > 0 && (
        <div className="mt-3 rounded-xl border border-border bg-bg/40 p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wide text-muted">Top zero-trust actions</span>
            {remMsg && <span className="text-2xs text-success">{remMsg}</span>}
          </div>
          <ul className="space-y-1">
            {data.recommendations.map((rec, i) => (
              <li key={i} className="flex items-start justify-between gap-2 text-2xs text-muted-light">
                <span className="flex items-start gap-2">
                  <span className="shrink-0 rounded bg-brand/15 px-1.5 py-0.5 text-brand">{rec.pillar}</span>
                  <span>{rec.text}</span>
                </span>
                {rec.action.kind === 'remediate' ? (
                  isAdmin && <button onClick={doRemediate} disabled={remediate.isPending} className="shrink-0 rounded-md bg-danger/15 px-2 py-0.5 text-2xs font-medium text-danger hover:bg-danger/25 disabled:opacity-50">{remediate.isPending ? '…' : '⚡ Remediate'}</button>
                ) : (
                  <Link href={rec.action.to ?? '#'} className="shrink-0 rounded-md border border-border bg-card px-2 py-0.5 text-2xs text-brand hover:text-white">{rec.action.label} →</Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {openPillar && <PillarRemediation pillar={openPillar} onClose={() => setOpenPillar(null)} />}
    </>
  );
  if (bare) return <div className="space-y-3">{body}</div>;
  return (
    <Card title="Zero-Trust Posture" className="col-span-12" action={<span className="text-2xs text-muted">{data.principle}</span>}>
      {body}
    </Card>
  );
}

/** Drill-down: what's needed to take a pillar to 100% — the failing/at-risk checks + where to fix them. */
function PillarRemediation({ pillar, onClose }: { pillar: ZtPillar; onClose: () => void }) {
  const guide = pillarGuide(pillar.name);
  const gaps = pillar.checks.filter((c) => c.status !== 'ok');
  const passed = pillar.checks.filter((c) => c.status === 'ok');
  const c = scoreColor(pillar.score);
  return (
    <Modal title={`${pillar.icon} ${pillar.name}`} subtitle="What it takes to reach 100%" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-bg/40 px-3 py-2">
          <span className="text-2xl font-bold tabular-nums" style={{ color: c }}>{pillar.score}<span className="text-sm text-muted">/100</span></span>
          <span className="text-2xs text-muted-light">{gaps.length === 0 ? 'All checks pass — this pillar is fully compliant.' : `${gaps.length} check(s) to resolve to reach 100%. Each control below adds to the score.`}</span>
        </div>

        <div className="rounded-lg border border-brand/25 bg-brand/5 px-3 py-2 text-2xs text-muted-light">
          <span className="font-semibold text-brand">Where to remediate: </span>{guide.where}
          <div className="mt-1.5"><Link href={guide.to} onClick={onClose} className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-soft">Open {guide.toLabel} →</Link></div>
        </div>

        {pillar.key === 'workload' && <WorkloadCoverage />}

        {gaps.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-2xs font-medium uppercase tracking-wide text-muted">Gaps to fix</span>
              <Link href="/help?doc=zt-remediation" onClick={onClose} className="text-2xs text-brand hover:underline">📖 Remediation guide →</Link>
            </div>
            <div className="divide-y divide-border-soft rounded-lg border border-border">
              {gaps.map((ch, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 text-2xs">
                  <span style={{ color: STATUS_COLOR[ch.status] }}>{ch.status === 'warn' ? '▲' : '✕'}</span>
                  <div className="min-w-0 flex-1">
                    <span className="text-white">{ch.label}</span>{ch.detail && <span className="text-muted"> — {ch.detail}</span>}
                    <Link href="/help?doc=zt-remediation" onClick={onClose} className="ml-1 whitespace-nowrap text-brand hover:underline">How to fix →</Link>
                  </div>
                  <span className="shrink-0 capitalize" style={{ color: STATUS_COLOR[ch.status] }}>{ch.status === 'warn' ? 'at risk' : 'failing'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {passed.length > 0 && (
          <div>
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Already compliant</div>
            <div className="divide-y divide-border-soft rounded-lg border border-border">
              {passed.map((ch, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 text-2xs">
                  <span className="text-success">✓</span>
                  <div className="min-w-0 flex-1"><span className="text-muted-light">{ch.label}</span>{ch.detail && <span className="text-muted"> — {ch.detail}</span>}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Workload coverage dashboard — every compute VM, whether it has a fresh posture agent / SSH-pull,
 *  its mode, last report and open vulnerabilities. Shown inside the Workload pillar drill-down. */
function WorkloadCoverage() {
  const { data, isLoading } = useZtWorkloads();
  const [wf, setWf] = useState<'all' | 'covered' | 'uncovered' | 'vulns'>('all');
  if (isLoading || !data) return <div className="rounded-lg border border-border bg-bg/40 p-3 text-2xs text-muted">Loading workloads…</div>;
  const pct = data.total ? Math.round((data.covered / data.total) * 100) : 0;
  const shown = data.vms.filter((v) => (wf === 'all' ? true : wf === 'covered' ? v.covered : wf === 'uncovered' ? !v.covered : v.vulnerabilities > 0));
  const fLabel = wf === 'covered' ? 'covered' : wf === 'uncovered' ? 'no-agent' : wf === 'vulns' ? 'with-vulns' : '';
  return (
    <div className="space-y-3">
      {/* Each tile is a filter — click to show only those VMs in the table below. */}
      <div className="grid grid-cols-4 gap-2">
        <MiniStat label="VMs" value={data.total} color="#3b82f6" active={wf === 'all'} onClick={() => setWf('all')} />
        <MiniStat label="Covered" value={data.covered} color="#22c55e" active={wf === 'covered'} onClick={() => setWf(wf === 'covered' ? 'all' : 'covered')} />
        <MiniStat label="No agent" value={data.uncovered} color="#f59e0b" active={wf === 'uncovered'} onClick={() => setWf(wf === 'uncovered' ? 'all' : 'uncovered')} />
        <MiniStat label="With vulns" value={data.withVulns} color="#ef4444" active={wf === 'vulns'} onClick={() => setWf(wf === 'vulns' ? 'all' : 'vulns')} />
      </div>
      <div>
        <div className="mb-1 flex justify-between text-2xs"><span className="text-muted">Posture coverage</span><span className="text-white">{data.covered}/{data.total} · {pct}%</span></div>
        <div className="h-2 w-full rounded-full bg-border"><div className="h-2 rounded-full" style={{ width: `${pct}%`, background: pct >= 80 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444' }} /></div>
      </div>
      {wf !== 'all' && <div className="flex items-center justify-between text-2xs"><span className="text-muted">Showing {shown.length} {fLabel} VM(s)</span><button onClick={() => setWf('all')} className="text-brand hover:underline">✕ clear filter</button></div>}
      <div className="max-h-72 overflow-auto rounded-lg border border-border">
        <table className="w-full text-2xs">
          <thead className="sticky top-0 bg-card text-left text-muted"><tr><th className="px-3 py-1.5 font-medium">VM</th><th className="px-3 py-1.5 font-medium">Posture</th><th className="px-3 py-1.5 font-medium">Last report</th><th className="px-3 py-1.5 text-right font-medium">Vulns</th><th className="px-3 py-1.5 text-right font-medium">Action</th></tr></thead>
          <tbody>
            {shown.map((v) => {
              const ip = v.publicIp || (/^\d{1,3}(\.\d{1,3}){3}$/.test(v.name) ? v.name : '');
              const enrolHref = `/command-center?enroll=1${ip ? `&host=${encodeURIComponent(ip)}` : ''}&os=${/win/i.test(v.os ?? '') ? 'windows' : 'linux'}`;
              return (
              <tr key={v.id} className="border-t border-border-soft">
                <td className="px-3 py-1.5"><span className="text-white">{v.name}</span> <span className="text-muted">· {v.provider}</span></td>
                <td className="px-3 py-1.5">
                  {v.covered
                    ? <span className="rounded bg-success/15 px-1.5 py-0.5 text-success">✓ {v.mode === 'ssh-pull' ? 'agent (SSH)' : 'agent'}</span>
                    : <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">✕ no agent</span>}
                </td>
                <td className="px-3 py-1.5 text-muted">{v.lastSeenAt ? timeAgo(v.lastSeenAt) : '—'}</td>
                <td className="px-3 py-1.5 text-right">{v.vulnerabilities > 0 ? <span className="text-danger">{v.vulnerabilities}</span> : <span className="text-muted">0</span>}</td>
                <td className="px-3 py-1.5 text-right">{!v.covered && <Link href={enrolHref} className="rounded border border-brand/50 bg-brand/10 px-2 py-0.5 font-medium text-brand hover:bg-brand/20">⤓ Enrol</Link>}</td>
              </tr>
            );})}
            {shown.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted">{data.vms.length === 0 ? 'No compute VMs discovered yet.' : `No ${fLabel} VMs.`}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="text-2xs text-muted">Enrol the <b className="text-warning">{data.uncovered}</b> uncovered VM(s) via <Link href="/command-center" className="text-brand hover:underline">Command Center → Add agent</Link> to bring coverage to 100%.</div>
    </div>
  );
}

function MiniStat({ label, value, color, active, onClick }: { label: string; value: number; color: string; active?: boolean; onClick?: () => void }) {
  const cls = `rounded-lg border px-2 py-1.5 text-center transition ${active ? 'border-brand bg-brand/10' : 'border-border bg-bg/40'}${onClick ? ' cursor-pointer hover:border-brand/50' : ''}`;
  const inner = (
    <>
      <div className="text-base font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-2xs text-muted">{label}</div>
    </>
  );
  return onClick ? <button onClick={onClick} className={`w-full ${cls}`}>{inner}</button> : <div className={cls}>{inner}</div>;
}
