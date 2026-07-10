'use client';

import { useEffect, useState } from 'react';
import { StatCard, Modal } from '@/components/ui';
import { Board } from '@/features/board/Board';
import { useAlertingOverview, useEvaluateNow, useAlerts, useAlertRules, useWorkflows } from '@/lib/hooks';
import { number, timeAgo } from '@/lib/format';
import type { BoardPanel } from '@/lib/types';

type SecDrill = 'active' | 'critical' | 'escalated' | 'rules' | 'workflows';
const SEV_COLOR: Record<string, string> = { critical: '#ef4444', high: '#f59e0b', medium: '#eab308', low: '#64748b', info: '#64748b' };

// Each tab is its own customizable board (independent saved layout per boardKey). Every panel is now a
// widget — drag to move, resize from the corner, add/remove from the catalog. Saved automatically.
type SecTab = 'posture' | 'alerts' | 'automation' | 'findings';
const SEC_TABS: { id: SecTab; label: string; icon: string; boardKey: string; seed: BoardPanel[] }[] = [
  {
    id: 'posture', label: 'Zero-Trust Posture', icon: '🛡', boardKey: 'security-posture',
    seed: [{ i: 'zt', kind: 'zerotrust-full', title: 'Zero-Trust Posture', x: 0, y: 0, w: 12, h: 11 }],
  },
  {
    id: 'alerts', label: 'Alert Rules', icon: '⚙', boardKey: 'security-alerts',
    seed: [{ i: 'rules', kind: 'alert-rules', title: 'Alert Rules', x: 0, y: 0, w: 12, h: 8 }],
  },
  {
    id: 'automation', label: 'Automation', icon: '⚡', boardKey: 'security-automation',
    seed: [
      { i: 'auto', kind: 'automation-full', title: 'Automation', x: 0, y: 0, w: 7, h: 9 },
      { i: 'chan', kind: 'delivery-channels', title: 'Delivery Channels', x: 7, y: 0, w: 5, h: 9 },
    ],
  },
  {
    id: 'findings', label: 'Cloud Findings', icon: '🔎', boardKey: 'security-findings',
    seed: [{ i: 'find', kind: 'findings', title: 'Cloud Security Findings', x: 0, y: 0, w: 12, h: 11 }],
  },
];

export function SecurityView() {
  const ov = useAlertingOverview();
  const evalNow = useEvaluateNow();
  const [tab, setTab] = useState<SecTab>('posture');
  const [drill, setDrill] = useState<SecDrill | null>(null);

  useEffect(() => {
    const h = window.location.hash.replace('#', '') as SecTab;
    if (SEC_TABS.some((t) => t.id === h)) setTab(h);
  }, []);
  const go = (id: SecTab) => {
    setTab(id);
    window.history.replaceState(null, '', `#${id}`);
  };
  const active = SEC_TABS.find((t) => t.id === tab) ?? SEC_TABS[0];
  const alertCount = ov.data?.kpis.activeAlerts ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">Security &amp; Alerting</div>
          <div className="text-2xs text-muted">Zero-trust posture · live alerts · automation. Each tab is a customizable board — drag to move, resize from the corner, add/remove widgets. Saved automatically.</div>
        </div>
        <button onClick={() => evalNow.mutate(undefined as never)} disabled={evalNow.isPending} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">
          {evalNow.isPending ? 'Evaluating…' : 'Evaluate now'}
        </button>
      </div>

      {/* Always-visible KPI strip — at-a-glance summary across every tab */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Active Alerts" value={number(alertCount)} accent="#ef4444" onClick={() => setDrill('active')} />
        <StatCard label="Critical" value={number(ov.data?.kpis.critical ?? 0)} accent="#ef4444" sub={`${ov.data?.kpis.high ?? 0} high`} onClick={() => setDrill('critical')} />
        <StatCard label="Escalated" value={number(ov.data?.kpis.escalated ?? 0)} accent="#a855f7" onClick={() => setDrill('escalated')} />
        <StatCard label="Alert Rules" value={number(ov.data?.kpis.rules ?? 0)} accent="#3b82f6" onClick={() => setDrill('rules')} />
        <StatCard label="Workflows" value={number(ov.data?.kpis.workflows ?? 0)} accent="#22c55e" onClick={() => setDrill('workflows')} />
      </div>

      {/* Tab bar — each tab mounts its own board */}
      <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
        {SEC_TABS.map((t) => {
          const on = t.id === active.id;
          return (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                on ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted hover:text-white'
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          );
        })}
      </div>

      <Board key={active.boardKey} boardKey={active.boardKey} seed={active.seed} />

      {drill && <SecDrillModal drill={drill} onClose={() => setDrill(null)} onManage={(t) => { setDrill(null); go(t); }} />}
    </div>
  );
}

const DRILL_TITLES: Record<SecDrill, string> = {
  active: 'Active alerts',
  critical: 'Critical & high alerts',
  escalated: 'Escalated alerts',
  rules: 'Alert rules',
  workflows: 'Automation workflows',
};

function SecDrillModal({ drill, onClose, onManage }: { drill: SecDrill; onClose: () => void; onManage: (t: SecTab) => void }) {
  const alerts = useAlerts('active');
  const rules = useAlertRules();
  const workflows = useWorkflows();

  const sev = (s: string) => <span className="rounded px-1.5 py-0.5 text-2xs font-medium" style={{ background: (SEV_COLOR[s] ?? '#64748b') + '22', color: SEV_COLOR[s] ?? '#94a3b8' }}>{s}</span>;
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

  let alertList = alerts.data ?? [];
  if (drill === 'critical') alertList = alertList.filter((a) => a.severity === 'critical' || a.severity === 'high');
  if (drill === 'escalated') alertList = alertList.filter((a) => a.escalated);
  alertList = [...alertList].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  return (
    <Modal wide onClose={onClose} title={DRILL_TITLES[drill]}>
      {(drill === 'active' || drill === 'critical' || drill === 'escalated') && (
        alerts.isLoading ? <Loading /> : !alertList.length ? <Ok>No {drill === 'active' ? 'active' : drill} alerts right now.</Ok> : (
          <Scroll>
            <Table head={['Severity', 'Alert', 'Resource', 'Source', 'Raised', 'Esc.']}>
              {alertList.map((a) => (
                <tr key={a.id} className="border-b border-border-soft align-top">
                  <td className="py-1.5 pr-3">{sev(a.severity)}</td>
                  <td className="py-1.5 pr-3 text-white">{a.title}</td>
                  <td className="py-1.5 pr-3 text-muted-light">{a.resourceName ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-muted">{a.source}</td>
                  <td className="py-1.5 pr-3 text-muted">{timeAgo(a.raisedAt)}</td>
                  <td className="py-1.5 pr-3">{a.escalated ? <span style={{ color: '#a855f7' }}>↑</span> : '—'}</td>
                </tr>
              ))}
            </Table>
          </Scroll>
        )
      )}

      {drill === 'rules' && (
        rules.isLoading ? <Loading /> : !rules.data?.length ? <Ok>No alert rules defined.</Ok> : (
          <Scroll>
            <Table head={['Rule', 'Condition', 'Severity', 'Scope', 'Status']}>
              {rules.data.map((r) => (
                <tr key={r.id} className="border-b border-border-soft align-top">
                  <td className="py-1.5 pr-3 text-white">{r.name}</td>
                  <td className="py-1.5 pr-3 font-mono text-muted-light">{r.event ? r.event : `${r.metric} ${r.comparator} ${r.threshold}`}</td>
                  <td className="py-1.5 pr-3">{sev(r.severity)}</td>
                  <td className="py-1.5 pr-3 text-muted">{r.scopeProvider ?? 'all'}{r.scopeEnv ? ` · ${r.scopeEnv}` : ''}</td>
                  <td className="py-1.5 pr-3">{r.enabled ? <span className="text-success">active</span> : <span className="text-muted">paused</span>}</td>
                </tr>
              ))}
            </Table>
            <button onClick={() => onManage('alerts')} className="mt-2 text-2xs text-brand hover:underline">Manage rules ↗</button>
          </Scroll>
        )
      )}

      {drill === 'workflows' && (
        workflows.isLoading ? <Loading /> : !workflows.data?.length ? <Ok>No automation workflows defined.</Ok> : (
          <Scroll>
            <Table head={['Workflow', 'Trigger', 'Action', 'Runs', 'Last run', 'Status']}>
              {workflows.data.map((w) => (
                <tr key={w.id} className="border-b border-border-soft align-top">
                  <td className="py-1.5 pr-3 text-white">{w.name}</td>
                  <td className="py-1.5 pr-3 text-muted-light">{w.trigger}</td>
                  <td className="py-1.5 pr-3 text-muted">{w.actionType}</td>
                  <td className="py-1.5 pr-3 text-muted">{w.runs}</td>
                  <td className="py-1.5 pr-3 text-muted">{w.lastRun ? timeAgo(w.lastRun) : 'never'}</td>
                  <td className="py-1.5 pr-3">{w.status === 'active' ? <span className="text-success">active</span> : <span className="text-muted">{w.status}</span>}</td>
                </tr>
              ))}
            </Table>
            <button onClick={() => onManage('automation')} className="mt-2 text-2xs text-brand hover:underline">Manage workflows ↗</button>
          </Scroll>
        )
      )}
    </Modal>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-left text-2xs">
      <thead className="sticky top-0 bg-panel text-muted"><tr className="border-b border-border">{head.map((h) => <th key={h} className="py-1.5 pr-3 font-medium">{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  );
}
function Scroll({ children }: { children: React.ReactNode }) { return <div className="max-h-[60vh] overflow-auto">{children}</div>; }
function Loading() { return <div className="py-6 text-center text-2xs text-muted">Loading…</div>; }
function Ok({ children }: { children: React.ReactNode }) { return <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-4 text-center text-2xs text-success">✓ {children}</div>; }
