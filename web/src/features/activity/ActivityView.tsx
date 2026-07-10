'use client';

import { useState } from 'react';
import { Card, ErrorState, LoadingState, Modal, SeverityBadge } from '@/components/ui';
import { useActivity, useActivitySummary, useResourceTimeline, useAlerts, useSiemStream, useAuditTrail, useActivityPredictive, useAckAlert, useResolveAlert } from '@/lib/hooks';
import { useTabParam } from '@/lib/useTabParam';
import { timeAgo, number } from '@/lib/format';

const TYPE_ICONS: Record<string, string> = {
  alert: '🚨', sync: '🔄', control: '🎛', finding: '🛡', cost: '💰', discovery: '🔍', system: '⚙', monitor: '📡',
};
const SEV_COLORS: Record<string, string> = { info: '#3b82f6', warning: '#f59e0b', critical: '#ef4444', high: '#f97316', low: '#22c55e' };
const LEVEL_COLORS: Record<string, string> = { info: '#3b82f6', warning: '#f59e0b', error: '#ef4444', critical: '#ef4444' };
const PROVIDERS = ['all', 'aws', 'azure', 'gcp', 'docker'];

/** A unified, clickable log row — any timeline event, SIEM event, alert or audit entry. */
export type LogEntry = {
  kind: 'event' | 'siem' | 'audit' | 'alert';
  ts: string; title: string; detail?: string | null;
  severity?: string; level?: string; type?: string; category?: string;
  source?: string; host?: string | null; resource?: string | null;
  provider?: string | null; actor?: string | null; ip?: string | null; metric?: string | null;
};

type Tab = 'predictive' | 'alerts' | 'siem' | 'timeline' | 'audit';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'predictive', label: 'Predictive Alerts', icon: '🔮' },
  { id: 'alerts', label: 'Active Alerts', icon: '🚨' },
  { id: 'siem', label: 'SIEM Stream', icon: '🛰' },
  { id: 'timeline', label: 'Event Timeline', icon: '📜' },
  { id: 'audit', label: 'Audit Trail', icon: '🔒' },
];

export function ActivityView() {
  const [tab, setTab] = useTabParam<Tab>('atab', 'predictive', ['predictive', 'alerts', 'siem', 'timeline', 'audit']);
  const [resource, setResource] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry | null>(null);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-panel px-4 py-3">
        <div className="text-sm font-semibold text-white">Activity &amp; Event Tracking</div>
        <div className="text-2xs text-muted">The single place for log, audit &amp; tracking — predictive alerting, active alerts, the SIEM stream, the cross-cloud event timeline and the security audit trail, all unified here.</div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === t.id ? 'bg-brand text-white' : 'border border-border bg-card text-muted hover:text-white'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'predictive' && <PredictiveTab onResource={setResource} onTab={setTab} />}
      {tab === 'alerts' && <AlertsTab onLog={setLog} />}
      {tab === 'siem' && <SiemTab onLog={setLog} />}
      {tab === 'timeline' && <TimelineTab onResource={setResource} onLog={setLog} />}
      {tab === 'audit' && <AuditTab onLog={setLog} />}

      {log && <LogDetailModal log={log} onClose={() => setLog(null)} onResource={(n) => { setLog(null); setResource(n); }} />}
      {resource && <ResourceCorrelation name={resource} onClose={() => setResource(null)} />}
    </div>
  );
}

/* ───────────────────────── Predictive alert dashboard ───────────────────────── */
function PredictiveTab({ onResource, onTab }: { onResource: (n: string) => void; onTab: (t: Tab) => void }) {
  const { data, isLoading, isError } = useActivityPredictive();
  const [info, setInfo] = useState<Explain | null>(null);
  if (isLoading) return <Card bodyClassName="p-4"><LoadingState rows={6} /></Card>;
  if (isError || !data) return <Card bodyClassName="p-4"><ErrorState /></Card>;
  const riskColor = data.kpis.riskScore >= 66 ? '#ef4444' : data.kpis.riskScore >= 33 ? '#f59e0b' : '#22c55e';
  const trendIcon = (t: string) => (t === 'rising' ? '▲' : t === 'falling' ? '▼' : '▬');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Kpi label="Fleet risk score" value={String(data.kpis.riskScore)} color={riskColor} onClick={() => setInfo(kpiExplain('risk', data, onTab))} />
        <Kpi label="Forecast alerts / next hr" value={number(data.kpis.forecastNextHour)} color="#a855f7" onClick={() => setInfo(kpiExplain('forecast', data, onTab))} />
        <Kpi label="At-risk resources" value={number(data.kpis.atRisk)} color="#f59e0b" onClick={() => setInfo(kpiExplain('atRisk', data, onTab))} />
        <Kpi label="Anomalies" value={number(data.kpis.anomalies)} color="#ef4444" onClick={() => setInfo(kpiExplain('anomalies', data, onTab))} />
        <Kpi label="Active alerts" value={number(data.kpis.activeAlerts)} color="#06b6d4" onClick={() => setInfo(kpiExplain('activeAlerts', data, onTab))} />
      </div>

      <Card title="Trend forecasts" bodyClassName="p-0" action={<span className="text-2xs text-muted">from {data.dataPoints} samples · click a row to understand it</span>}>
        {data.predictions.length === 0 ? (
          <div className="px-4 py-8 text-center text-2xs text-muted">Not enough metric history yet — predictions appear once the engine has collected a few samples.</div>
        ) : (
          <div className="divide-y divide-border-soft">
            {data.predictions.map((p) => (
              <button key={p.metric} onClick={() => setInfo(predExplain(p))} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition hover:bg-card-hover/40" title="Explain this forecast">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEV_COLORS[p.severity] ?? '#64748b' }} />
                <div className="min-w-0 flex-1">
                  <div className="text-2xs text-white">{p.label} <span className="text-muted">— now {p.current}{p.unit}</span></div>
                  <div className="text-2xs text-muted">
                    <span style={{ color: p.trend === 'rising' ? '#f59e0b' : p.trend === 'falling' ? '#22c55e' : '#64748b' }}>{trendIcon(p.trend)} {p.trend}</span>
                    {p.slopePerHr !== 0 && <span> · {p.slopePerHr > 0 ? '+' : ''}{p.slopePerHr}{p.unit}/hr</span>}
                    <span> · threshold {p.threshold}{p.unit}</span>
                    {p.anomaly && <span className="ml-1 rounded bg-danger/15 px-1 text-danger">anomaly</span>}
                  </div>
                </div>
                {p.willBreach ? (
                  <span className="shrink-0 rounded px-2 py-0.5 text-2xs font-medium" style={{ background: `${SEV_COLORS[p.severity]}22`, color: SEV_COLORS[p.severity] }}>breaches in {p.eta}</span>
                ) : p.current >= p.threshold ? (
                  <span className="shrink-0 rounded bg-danger/15 px-2 py-0.5 text-2xs font-medium text-danger">over threshold</span>
                ) : (
                  <span className="shrink-0 text-2xs text-muted">within limits</span>
                )}
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Resources at risk now" bodyClassName="p-0">
        {data.atRisk.length === 0 ? (
          <div className="px-4 py-8 text-center text-2xs text-muted">No resources above 80% CPU / memory / disk.</div>
        ) : (
          <div className="divide-y divide-border-soft">
            {data.atRisk.map((r) => (
              <button key={r.id} onClick={() => onResource(r.name)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left transition hover:bg-card-hover/40" title="Open this resource's events">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.worst >= 90 ? '#ef4444' : '#f59e0b' }} />
                <div className="min-w-0 flex-1"><span className="text-2xs text-white">{r.name}</span> <span className="text-2xs text-muted">· {r.provider}</span></div>
                <div className="flex shrink-0 gap-3 text-2xs text-muted">
                  <span className={r.which === 'cpu' ? 'text-warning' : ''}>CPU {r.cpu}%</span>
                  <span className={r.which === 'memory' ? 'text-warning' : ''}>Mem {r.memory}%</span>
                  <span className={r.which === 'disk' ? 'text-warning' : ''}>Disk {r.disk}%</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Per-host capacity forecast" bodyClassName="p-0" action={<span className="text-2xs text-muted">when each host crosses 90% (from its own trend)</span>}>
        {(data.resourceForecasts?.length ?? 0) === 0 ? (
          <div className="px-4 py-8 text-center text-2xs text-muted">No host is trending toward saturation in the next 7 days.</div>
        ) : (
          <div className="divide-y divide-border-soft">
            {data.resourceForecasts.map((f) => (
              <button key={f.id + f.metric} onClick={() => onResource(f.name)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left transition hover:bg-card-hover/40" title="Open this resource's events">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: f.etaMin < 1440 ? '#ef4444' : '#f59e0b' }} />
                <div className="min-w-0 flex-1"><span className="text-2xs text-white">{f.name}</span> <span className="text-2xs text-muted">· {f.provider} · {f.metric} {f.current}% (+{f.slopePerHr}%/hr)</span></div>
                <span className={`shrink-0 text-2xs ${f.etaMin < 1440 ? 'text-danger' : 'text-warning'}`}>→ {f.threshold}% in {f.eta}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {info && <ExplainModal data={info} onClose={() => setInfo(null)} />}
    </div>
  );
}

/* ───────────────────────── Active alerts ───────────────────────── */
function AlertsTab({ onLog }: { onLog: (l: LogEntry) => void }) {
  const { data, isLoading, isError } = useAlerts('active');
  const ack = useAckAlert();
  const resolve = useResolveAlert();
  const alerts = data ?? [];
  return (
    <Card title={`Active Alerts (${alerts.length})`} bodyClassName="p-0">
      {isLoading ? (
        <div className="p-4"><LoadingState rows={5} /></div>
      ) : isError ? (
        <div className="p-4"><ErrorState /></div>
      ) : alerts.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">No active alerts. Define rules in <a href="/management" className="text-brand hover:underline">Management → Alert Rules</a>; the engine raises alerts on live metrics.</div>
      ) : (
        <div className="divide-y divide-border-soft">
          {alerts.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-card-hover/40">
              <SeverityBadge severity={a.severity} />
              <button onClick={() => onLog({ kind: 'alert', ts: a.raisedAt, title: a.title, severity: a.severity, source: a.source, resource: a.resourceName, metric: a.metric, host: a.resourceName })} className="min-w-0 flex-1 cursor-pointer text-left" title="Open details">
                <div className="text-2xs text-white">{a.title}{a.escalated && <span className="ml-1 rounded bg-danger/15 px-1 text-danger">escalated</span>}</div>
                <div className="text-2xs text-muted">{a.source}{a.resourceName ? ` · ${a.resourceName}` : ''}{a.metric ? ` · ${a.metric}=${a.value}` : ''}</div>
              </button>
              <span className="shrink-0 text-2xs text-muted">{timeAgo(a.raisedAt)}</span>
              {a.status === 'active' && <button onClick={() => ack.mutate(a.id)} className="shrink-0 rounded border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-light hover:text-white">ack</button>}
              <button onClick={() => resolve.mutate(a.id)} className="shrink-0 rounded border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-light hover:text-white">resolve</button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────── SIEM stream ───────────────────────── */
function SiemTab({ onLog }: { onLog: (l: LogEntry) => void }) {
  const { data, isLoading, isError } = useSiemStream();
  const events = data ?? [];
  return (
    <Card title="SIEM Event Stream" bodyClassName="p-0" action={<span className="text-2xs text-muted">{events.length} events · click a row for detail</span>}>
      {isLoading ? (
        <div className="p-4"><LoadingState rows={6} /></div>
      ) : isError ? (
        <div className="p-4"><ErrorState /></div>
      ) : events.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">No SIEM events yet — agents and monitors feed this stream.</div>
      ) : (
        <div className="max-h-[34rem] divide-y divide-border-soft overflow-auto font-mono">
          {events.map((e) => (
            <button key={e.id} onClick={() => onLog({ kind: 'siem', ts: e.ts, title: e.message, level: e.level, category: e.category, host: e.host, source: e.source })} className="flex w-full cursor-pointer items-start gap-2 px-4 py-2 text-left text-2xs transition hover:bg-card-hover/40" title="Open details">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LEVEL_COLORS[e.level] ?? '#64748b' }} />
              <span className="shrink-0 text-muted" title={new Date(e.ts).toLocaleString()}>{timeAgo(e.ts)}</span>
              <span className="shrink-0 uppercase text-muted-light">{e.category}</span>
              {e.host && <span className="shrink-0 text-brand">{e.host}</span>}
              <span className="min-w-0 flex-1 break-words text-white">{e.message}</span>
              <span className="shrink-0 text-muted">{e.source}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────── Audit trail ───────────────────────── */
function AuditTab({ onLog }: { onLog: (l: LogEntry) => void }) {
  const { data, isLoading, isError } = useAuditTrail();
  const rows = data ?? [];
  return (
    <Card title="Security Audit Trail" bodyClassName="p-0" action={<span className="text-2xs text-muted">{rows.length} entries</span>}>
      {isLoading ? (
        <div className="p-4"><LoadingState rows={6} /></div>
      ) : isError ? (
        <div className="p-4"><ErrorState /></div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">No audit entries yet.</div>
      ) : (
        <div className="max-h-[34rem] divide-y divide-border-soft overflow-auto">
          {rows.map((r) => (
            <button key={r.id} onClick={() => onLog({ kind: 'audit', ts: r.ts, title: r.action, detail: r.detail, actor: r.actorEmail, resource: r.targetEmail, ip: r.ip, type: 'audit', category: 'audit' })} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left text-2xs transition hover:bg-card-hover/40" title="Open details">
              <span className="shrink-0 text-muted" title={new Date(r.ts).toLocaleString()}>{timeAgo(r.ts)}</span>
              <span className="shrink-0 rounded bg-border/40 px-1.5 text-muted-light">{r.action}</span>
              <span className="min-w-0 flex-1 text-white">{r.actorEmail || '—'}{r.targetEmail ? ` → ${r.targetEmail}` : ''}{r.detail ? ` · ${r.detail}` : ''}</span>
              {r.ip && <span className="shrink-0 text-muted">{r.ip}</span>}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────── Event timeline (original) ───────────────────────── */
function TimelineTab({ onResource, onLog }: { onResource: (n: string) => void; onLog: (l: LogEntry) => void }) {
  const summary = useActivitySummary();
  const [type, setType] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [provider, setProvider] = useState('all');
  const [q, setQ] = useState('');
  const events = useActivity({ type, severity, provider, q });
  const sevCount = (s: string) => summary.data?.bySeverity.find((x) => x.severity === s)?.count ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Kpi label="Total Events" value={number(summary.data?.total ?? 0)} color="#3b82f6" />
        <Kpi label="Last 24h" value={number(summary.data?.last24h ?? 0)} color="#06b6d4" />
        <Kpi label="Critical" value={number(sevCount('critical'))} color="#ef4444" />
        <Kpi label="Warning" value={number(sevCount('warning'))} color="#f59e0b" />
        <Kpi label="Info" value={number(sevCount('info'))} color="#22c55e" />
      </div>

      <Card bodyClassName="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title / resource / detail…" className="w-56 rounded-lg border border-border bg-bg px-3 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
          <Select value={type} onChange={setType} options={['all', ...(summary.data?.byType.map((t) => t.type) ?? [])]} />
          <Select value={severity} onChange={setSeverity} options={['all', 'critical', 'warning', 'info']} />
          <Select value={provider} onChange={setProvider} options={PROVIDERS} />
          <span className="ml-auto text-2xs text-muted">{events.data?.length ?? 0} events</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {summary.data?.byType.map((t) => (
            <button key={t.type} onClick={() => setType(type === t.type ? 'all' : t.type)} className={`rounded-full border px-2 py-0.5 text-2xs ${type === t.type ? 'border-brand bg-brand/15 text-white' : 'border-border bg-card text-muted-light hover:text-white'}`}>
              {TYPE_ICONS[t.type] ?? '•'} {t.type} ({t.count})
            </button>
          ))}
        </div>
      </Card>

      <Card title="Event Timeline" bodyClassName="p-0">
        {events.isLoading ? (
          <div className="p-4"><LoadingState rows={6} /></div>
        ) : events.isError ? (
          <div className="p-4"><ErrorState /></div>
        ) : events.data?.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted">No events match the filters.</div>
        ) : (
          <div className="max-h-[34rem] divide-y divide-border-soft overflow-auto">
            {events.data?.map((e) => (
              <div key={e.id} onClick={() => onLog({ kind: 'event', ts: e.ts, title: e.title, detail: e.detail, severity: e.severity, type: e.type, provider: e.provider, resource: e.resourceName, host: e.resourceName, category: e.type })} className="flex cursor-pointer items-start gap-3 px-4 py-2.5 transition hover:bg-card-hover/40" title="Open details">
                <span className="mt-0.5 text-sm">{TYPE_ICONS[e.type] ?? '•'}</span>
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: SEV_COLORS[e.severity] ?? '#64748b' }} />
                <div className="min-w-0 flex-1">
                  <div className="text-2xs text-white">{e.title}</div>
                  {e.detail && <div className="truncate text-2xs text-muted">{e.detail}</div>}
                  <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted">
                    <span className="uppercase">{e.type}</span>
                    {e.provider && <span>· {e.provider}</span>}
                    {e.resourceName && (
                      <button onClick={(ev) => { ev.stopPropagation(); onResource(e.resourceName!); }} className="text-brand hover:underline">· {e.resourceName} ↗</button>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-2xs text-muted" title={new Date(e.ts).toLocaleString()}>{timeAgo(e.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ResourceCorrelation({ name, onClose }: { name: string; onClose: () => void }) {
  const tl = useResourceTimeline(name);
  return (
    <Modal title={name} subtitle="Correlated events & alerts for this resource" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Active &amp; recent alerts</div>
          {tl.data?.alerts.length ? (
            <div className="divide-y divide-border-soft rounded-lg border border-border">
              {tl.data.alerts.map((a) => (
                <div key={a.id} className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2"><SeverityBadge severity={a.severity} /><span className="text-2xs text-white">{a.title}</span></div>
                  <span className="text-2xs capitalize" style={{ color: a.status === 'resolved' ? '#64748b' : '#f59e0b' }}>{a.status} · {timeAgo(a.raisedAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border px-3 py-2 text-2xs text-muted">No alerts for this resource.</div>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Event history</div>
          <div className="max-h-72 divide-y divide-border-soft overflow-auto rounded-lg border border-border">
            {tl.data?.events.map((e) => (
              <div key={e.id} className="flex items-start gap-2 px-3 py-2">
                <span className="text-2xs">{TYPE_ICONS[e.type] ?? '•'}</span>
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SEV_COLORS[e.severity] ?? '#64748b' }} />
                <div className="min-w-0 flex-1"><div className="text-2xs text-white">{e.title}</div>{e.detail && <div className="truncate text-2xs text-muted">{e.detail}</div>}</div>
                <span className="shrink-0 text-2xs text-muted">{timeAgo(e.ts)}</span>
              </div>
            ))}
            {tl.data?.events.length === 0 && <div className="px-3 py-3 text-center text-2xs text-muted">No events.</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Plain-English background for a log — what it means and what to check. */
function explainLog(l: LogEntry): string {
  const t = `${l.title} ${l.detail ?? ''} ${l.category ?? ''} ${l.type ?? ''} ${l.metric ?? ''}`.toLowerCase();
  const sev = (l.severity || l.level || '').toLowerCase();
  if (/\bdown\b|unreachable|offline|no response|reachability/.test(t)) return 'A monitored resource (VM / firewall / switch / router) stopped responding to health checks (ping / heartbeat) and is considered DOWN until it answers again. Typical causes: the host is powered off or crashed, a network link or route is broken, or a firewall is dropping the probe. Check power & connectivity on the device, then the path and firewall rules to it.';
  if (/recovered|reachable|back online|link up|\bup\b/.test(t)) return 'A previously-down resource started responding again — MCMF auto-resolves the related alert. The outage window is the gap between the DOWN event and this recovery.';
  if (/link down/.test(t)) return 'A network-device interface (port / link) went down. Everything reached through that switch or router port is isolated until the link is restored.';
  if (l.kind === 'audit') return `An immutable audit record of an administrative action ("${l.title}")${l.actor ? ` performed by ${l.actor}` : ''}. Audit entries are retained ~4× longer than operational logs for compliance.`;
  if (/finding|vulnerab|cve|exposed|posture/.test(t)) return 'A security finding from posture / VAPT scanning. Open Security for the rule, the affected resource and the remediation steps.';
  if (/cost|spend|budget|finops/.test(t)) return 'A cost / FinOps event — for example a budget threshold breach or a spend anomaly. Open FinOps & Carbon for the breakdown.';
  if (/cpu|memory|\bmem\b|disk|load|threshold/.test(t)) return 'A performance threshold was crossed on this resource. Review the correlated activity below and the resource’s telemetry in Monitoring.';
  if (sev === 'critical' || sev === 'high') return 'A high-severity event that usually needs attention. The correlated activity below shows what else happened on the same resource around this time — often the cause or the blast radius.';
  return 'An operational event recorded in the activity log. The correlated activity below shows what else happened on the same resource around this time.';
}

/** Correlated alerts + events on a resource — the "background" of a log. */
function LogCorrelation({ name, onResource }: { name: string; onResource: (n: string) => void }) {
  const tl = useResourceTimeline(name);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted">Background — correlated activity on {name}</span>
        <button onClick={() => onResource(name)} className="text-2xs text-brand hover:underline">Full resource timeline ↗</button>
      </div>
      {tl.isLoading ? (
        <div className="text-2xs text-muted">Loading…</div>
      ) : (
        <div className="space-y-2">
          {(tl.data?.alerts?.length ?? 0) > 0 && (
            <div className="divide-y divide-border-soft rounded-lg border border-border">
              {tl.data!.alerts.slice(0, 5).map((a) => (
                <div key={a.id} className="flex items-center justify-between px-3 py-1.5">
                  <div className="flex items-center gap-2"><SeverityBadge severity={a.severity} /><span className="text-2xs text-white">{a.title}</span></div>
                  <span className="text-2xs capitalize" style={{ color: a.status === 'resolved' ? '#64748b' : '#f59e0b' }}>{a.status} · {timeAgo(a.raisedAt)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="max-h-56 divide-y divide-border-soft overflow-auto rounded-lg border border-border">
            {(tl.data?.events ?? []).slice(0, 12).map((e) => (
              <div key={e.id} className="flex items-start gap-2 px-3 py-1.5">
                <span className="text-2xs">{TYPE_ICONS[e.type] ?? '•'}</span>
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SEV_COLORS[e.severity] ?? '#64748b' }} />
                <div className="min-w-0 flex-1"><div className="text-2xs text-white">{e.title}</div>{e.detail && <div className="truncate text-2xs text-muted">{e.detail}</div>}</div>
                <span className="shrink-0 text-2xs text-muted">{timeAgo(e.ts)}</span>
              </div>
            ))}
            {(tl.data?.events?.length ?? 0) === 0 && <div className="px-3 py-3 text-center text-2xs text-muted">No other recent activity on this resource.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Click any log → full detail + plain-English background + correlated activity. */
function LogDetailModal({ log, onClose, onResource }: { log: LogEntry; onClose: () => void; onResource: (n: string) => void }) {
  const name = log.resource || log.host || null;
  const sev = log.severity || log.level || 'info';
  const color = SEV_COLORS[sev] ?? LEVEL_COLORS[sev] ?? '#64748b';
  const fields: [string, any][] = [
    ['Type', log.type || log.kind], ['Category', log.category], ['Severity', sev], ['Source', log.source],
    ['Host / resource', name], ['Provider', log.provider], ['Actor', log.actor], ['IP', log.ip], ['Metric', log.metric],
  ];
  return (
    <Modal title={<span className="flex items-center gap-2"><span>{TYPE_ICONS[log.type ?? log.kind] ?? '•'}</span><span className="break-words">{log.title}</span></span>} subtitle={`${log.kind.toUpperCase()} · ${new Date(log.ts).toLocaleString()} (${timeAgo(log.ts)})`} onClose={onClose} wide>
      <div className="space-y-4">
        <div><span className="rounded px-2 py-0.5 text-2xs font-medium uppercase" style={{ background: `${color}22`, color }}>{sev}</span></div>
        {log.detail && (
          <div>
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted">Detail</div>
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-3 text-2xs text-muted-light">{log.detail}</pre>
          </div>
        )}
        <div>
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Fields</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {fields.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border bg-bg/40 px-2.5 py-1.5">
                <div className="text-2xs uppercase tracking-wide text-muted">{k}</div>
                <div className="mt-0.5 break-words text-2xs font-medium text-white">{String(v)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-brand/25 bg-brand/5 p-3">
          <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-brand">What this means</div>
          <div className="text-2xs leading-relaxed text-muted-light">{explainLog(log)}</div>
        </div>
        {name && <LogCorrelation name={name} onResource={onResource} />}
      </div>
    </Modal>
  );
}

/* ───────────────────────── Explain (predictive KPIs & forecasts) ───────────────────────── */
type Explain = { icon?: string; title: string; lead: string; rows?: [string, React.ReactNode][]; note?: string };

function ExplainModal({ data, onClose }: { data: Explain; onClose: () => void }) {
  return (
    <Modal title={<span className="flex items-center gap-2">{data.icon && <span>{data.icon}</span>}<span>{data.title}</span></span>} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="text-xs leading-relaxed text-muted-light">{data.lead}</div>
        {data.rows && data.rows.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {data.rows.map(([k, v], i) => (
              <div key={i} className="rounded-lg border border-border bg-bg/40 px-3 py-2">
                <div className="text-2xs uppercase tracking-wide text-muted">{k}</div>
                <div className="mt-0.5 text-2xs font-medium text-white">{v}</div>
              </div>
            ))}
          </div>
        )}
        {data.note && <div className="rounded-lg border border-brand/25 bg-brand/5 p-3 text-2xs leading-relaxed text-muted-light"><b className="text-brand">What to do · </b>{data.note}</div>}
      </div>
    </Modal>
  );
}

function kpiExplain(k: string, data: any, _onTab: (t: Tab) => void): Explain {
  const kp = data.kpis;
  if (k === 'risk') return { icon: '🎯', title: 'Fleet risk score', lead: 'A 0–100 composite of how close your whole fleet is to trouble right now. It blends how many resources are near their CPU / memory / disk thresholds, the number of active alerts and anomalies, and the short-term forecast. Lower is better.', rows: [['Your score', `${kp.riskScore} / 100`], ['Band', kp.riskScore >= 66 ? 'At risk (red)' : kp.riskScore >= 33 ? 'Watch (amber)' : 'Healthy (green)'], ['Inputs', `${kp.atRisk} at-risk · ${kp.anomalies} anomalies · ${kp.activeAlerts} active alerts`]], note: 'If it climbs into amber or red, review "Resources at risk now" and the Active Alerts tab.' };
  if (k === 'forecast') return { icon: '🔮', title: 'Forecast alerts / next hour', lead: 'An estimate of how many threshold-breach alerts are likely to fire in the next hour. The engine fits a trend line (least-squares linear regression) to each metric’s recent samples and projects it forward; metrics heading toward their threshold count toward this number.', rows: [['Forecast', `${kp.forecastNextHour} alert(s) / hr`], ['Based on', `${data.dataPoints} metric samples`]], note: 'Click any row in "Trend forecasts" that says "breaches in …" to see exactly which metric and when.' };
  if (k === 'atRisk') return { icon: '⚠️', title: 'At-risk resources', lead: 'Resources currently above 80% on CPU, memory or disk — the ones most likely to cause an incident soon. They are listed under "Resources at risk now" below.', rows: [['Count', String(kp.atRisk)]], note: 'Click a resource in "Resources at risk now" to see its recent events and alerts.' };
  if (k === 'anomalies') return { icon: '📈', title: 'Anomalies', lead: 'Metrics whose latest reading deviates sharply from their own recent baseline (a z-score spike or drop) — unusual even if still within limits. Anomalies often appear just before an incident.', rows: [['Count', String(kp.anomalies)]], note: 'Look for the red "anomaly" tag in the Trend forecasts list and click that row for detail.' };
  return { icon: '🚨', title: 'Active alerts', lead: 'Alerts that are currently firing and not yet resolved across the fleet.', rows: [['Count', String(kp.activeAlerts)]], note: 'Open the Active Alerts tab to acknowledge or resolve them.' };
}

function predExplain(p: any): Explain {
  const forecast = p.willBreach
    ? `Projected to cross the ${p.threshold}${p.unit} threshold in about ${p.eta} if the current trend holds.`
    : p.current >= p.threshold
      ? `Already at or over the ${p.threshold}${p.unit} threshold.`
      : `Within limits — at the current trend it is not expected to reach the ${p.threshold}${p.unit} threshold any time soon.`;
  const trendWord = p.trend === 'rising' ? 'rising (getting worse for a usage metric)' : p.trend === 'falling' ? 'falling (getting better)' : 'flat';
  const rows: [string, React.ReactNode][] = [
    ['Now', `${p.current}${p.unit}`],
    ['Trend', `${trendWord}${p.slopePerHr !== 0 ? ` · ${p.slopePerHr > 0 ? '+' : ''}${p.slopePerHr}${p.unit}/hr` : ''}`],
    ['Threshold', `${p.threshold}${p.unit}`],
    ['Forecast', forecast],
  ];
  if (p.anomaly) rows.push(['Anomaly', 'The latest reading is statistically unusual vs its recent baseline.']);
  return {
    icon: '📉', title: `${p.label} — forecast`,
    lead: `This is the fleet-wide ${p.label.toLowerCase()}. The engine fits a least-squares trend line to its recent samples and projects whether it will cross its alert threshold. "Falling" is good for a usage metric; "rising" toward the threshold is what triggers a forecast alert.`,
    rows,
    note: p.willBreach ? 'Act before it breaches — scale up or clean up the affected resources (see "Resources at risk now"), or shift the workload.' : 'No action needed right now; keep an eye on it if the trend reverses.',
  };
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-border bg-bg px-2 py-1.5 text-xs capitalize text-white focus:border-brand focus:outline-none">
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Kpi({ label, value, color, onClick }: { label: string; value: string; color: string; onClick?: () => void }) {
  const inner = (
    <>
      <div className="text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-2xs text-muted">{label}{onClick && <span className="ml-1 opacity-40">ⓘ</span>}</div>
    </>
  );
  const cls = 'rounded-xl border border-border bg-card/60 px-4 py-3';
  return onClick
    ? <button onClick={onClick} className={`${cls} w-full cursor-pointer text-left transition hover:border-brand/50 hover:bg-card-hover/40`} title="What is this?">{inner}</button>
    : <div className={cls}>{inner}</div>;
}
