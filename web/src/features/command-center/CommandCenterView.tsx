'use client';

import { useState, useEffect } from 'react';
import { Badge, Card, ErrorState, LoadingState, ProgressBar, StatCard } from '@/components/ui';
import { useCommandCenter, useAiStatus, useAiAssistant, useRca, useUpdateAgent, useRemoveAgent, useEnqueueAgentCommand, useEnrollPull, useAgents, useAgentPullNow, useAgentPushAgent, useVms, useMonitors } from '@/lib/hooks';
import { useAuthUser } from '@/lib/auth';
import { PROVIDER_COLORS, SEVERITY_COLORS, STATUS_COLORS, number, pct, timeAgo } from '@/lib/format';
import type { CommandCenterOverview } from '@/lib/types';

const utilColor = (v: number | null) => (v == null ? '#64748b' : v >= 90 ? '#ef4444' : v >= 70 ? '#f59e0b' : '#22c55e');

export function CommandCenterView() {
  const { data, isLoading, isError, error } = useCommandCenter();
  // Guest Agents share the IP/Host Monitor group scope — centralized ("All groups") or per-group.
  const [agentGroup, setAgentGroup] = useState('all');

  if (isLoading) return <LoadingState rows={6} />;
  if (isError || !data) return <ErrorState message={(error as Error)?.message} />;

  const { kpis, alerts, incidents, aiEngine, workflows, topConsumers, agents } = data;
  const agentGroups = [...new Set(agents.map((a) => a.group || 'default'))].sort();
  const shownAgents = agentGroup === 'all' ? agents : agents.filter((a) => (a.group || 'default') === agentGroup);

  return (
    <div className="space-y-4">
      {/* AI assistant + RCA */}
      <AiPanel incidents={incidents} alerts={alerts} />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total Resources" value={number(kpis.totalResources)} accent="#3b82f6" href="/inventory" />
        <StatCard label="Active Alerts" value={number(kpis.activeAlerts)} accent="#ef4444" sub={`${kpis.criticalAlerts} critical`} href="/activity" />
        <StatCard label="Active Incidents" value={number(kpis.activeIncidents)} accent="#f59e0b" href="/activity" />
        <StatCard label="Avg CPU / Mem" value={`${pct(kpis.avgCpu)} / ${pct(kpis.avgMemory)}`} accent="#22c55e" sub={`${kpis.networkGbps} Gbps network`} href="/monitoring" />
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* AI engine */}
        <Card title="Cloud AI Engine" className="col-span-12 lg:col-span-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-purple text-lg">
              ✨
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">AIOps Engine</span>
                <Badge color="#22c55e" tone="dot">{aiEngine.status}</Badge>
              </div>
              <div className="text-2xs text-muted">{aiEngine.model} · {Math.round(aiEngine.confidence * 100)}% confidence</div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-center">
            <Metric label="Anomalies" value={aiEngine.anomaliesDetected} />
            <div className="rounded-lg border border-border bg-card-hover/40 py-2">
              <div className="text-base font-semibold text-white">{aiEngine.forecast ? `${aiEngine.forecast.predicted}%` : '—'}</div>
              <div className="text-2xs text-muted">CPU forecast {aiEngine.forecast ? `(${aiEngine.forecast.trend})` : ''}</div>
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-brand/20 bg-brand/5 p-3 text-xs leading-relaxed text-muted-light">
            <span className="font-medium text-brand">Insight · </span>{aiEngine.insight}
          </div>
          {aiEngine.anomalies.length > 0 && (
            <div className="mt-2 space-y-1">
              {aiEngine.anomalies.slice(0, 4).map((a, i) => (
                <div key={i} className="flex items-start gap-1.5 text-2xs text-muted-light"><span className="text-danger">▲</span><span>{a.note}</span></div>
              ))}
            </div>
          )}
        </Card>

        {/* Top consumers */}
        <Card title="Top Resource Consumers" className="col-span-12 lg:col-span-3">
          <div className="space-y-3">
            {topConsumers.map((r) => (
              <div key={r.id}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 truncate text-muted-light">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: PROVIDER_COLORS[r.provider] }} />
                    <span className="truncate">{r.name}</span>
                  </span>
                  <span className="font-medium text-white">{pct(r.cpu)}</span>
                </div>
                <ProgressBar value={r.cpu} color={r.cpu > 85 ? '#ef4444' : '#3b82f6'} height={5} />
              </div>
            ))}
          </div>
        </Card>

        {/* Guest agents — agentless SSH / push agents, grouped by the shared IP/Host Monitor scope. */}
        <Card
          title="Guest Agents"
          className="col-span-12 lg:col-span-6"
          bodyClassName="p-0"
          action={
            <div className="flex items-center gap-2">
              {agentGroups.length > 1 && (
                <select value={agentGroup} onChange={(e) => setAgentGroup(e.target.value)} title="Filter by monitor group (shared with IP/Host Monitor)" className="rounded border border-border bg-bg px-1.5 py-0.5 text-2xs text-white focus:border-brand focus:outline-none">
                  <option value="all">All groups</option>
                  {agentGroups.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              )}
              <Badge color="#3b82f6">{shownAgents.length}</Badge>
            </div>
          }
        >
          <SshPullForm />
          <div className="divide-y divide-border-soft">
            {shownAgents.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">{agents.length === 0 ? <>No agents yet. MCMF is private, so use <b className="text-white">Add agent</b> above — MCMF connects out to the VM over SSH and pulls memory/disk/network/services/event logs (no software to install on the host).</> : <>No agents in group <b className="text-white">{agentGroup}</b>.</>}</div>}
            {shownAgents.map((a) => <AgentRow key={a.id} a={a} />)}
          </div>
        </Card>

        {/* Per-VM services monitoring — select a VM, see its services + CPU/RAM/disk/net */}
        <ServicesMonitor />

        {/* Alerts, the SIEM stream and the event log now live in one place: Activity & Event Tracking. */}

        {/* Automation workflows */}
        <Card title="Automation Workflows" className="col-span-12 lg:col-span-6" bodyClassName="p-0">
          <div className="divide-y divide-border-soft">
            {workflows.map((w) => (
              <div key={w.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-card-hover">
                <div>
                  <div className="text-sm font-medium text-white">{w.name}</div>
                  <div className="text-2xs text-muted">Trigger: {w.trigger}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-2xs text-muted">{number(w.runs)} runs</span>
                  <Badge color={STATUS_COLORS[w.status] ?? '#22c55e'} tone="dot">{w.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Active incidents — kept at the bottom of Command Center. */}
        <Card title="Active Incidents" className="col-span-12" bodyClassName="p-0">
          <div className="divide-y divide-border-soft">
            {incidents.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">No active incidents.</div>}
            {incidents.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-card-hover">
                <div className="flex items-center gap-3">
                  <span className="h-2 w-2 rounded-full" style={{ background: SEVERITY_COLORS[i.severity] }} />
                  <div>
                    <div className="text-sm font-medium text-white">{i.title}</div>
                    <div className="text-2xs text-muted">{i.resourceName} · {timeAgo(i.openedAt)}</div>
                  </div>
                </div>
                <span className="text-2xs capitalize" style={{ color: STATUS_COLORS[i.status] }}>{i.status}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Per-VM services monitoring — select a VM, see its running services + CPU/RAM/disk/network (pulled over SSH). */
function ServicesMonitor() {
  const agents = useAgents();
  const pull = useAgentPullNow();
  const { data: me } = useAuthUser();
  const canPull = me?.role === 'admin' || me?.role === 'operator';
  const [sel, setSel] = useState<string>('');
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const list = agents.data ?? [];
  const a = list.find((x) => x.id === sel) ?? list[0];

  const doPull = async () => {
    if (!a) return;
    setMsg('Pulling from VM…');
    try { await pull.mutateAsync(a.id); setMsg('Pulled fresh data ✓'); }
    catch (e) { setMsg((e as Error).message); }
    setTimeout(() => setMsg(null), 3500);
  };

  const services = a?.services ?? [];
  const filtered = services
    .filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()))
    .sort((x, y) => (y.cpu ?? -1) - (x.cpu ?? -1) || (y.mem ?? -1) - (x.mem ?? -1));
  const hasUtil = services.some((s) => s.cpu != null || s.mem != null);

  return (
    <Card
      title="Services Monitoring (per VM)"
      className="col-span-12 lg:col-span-6"
      bodyClassName="p-0"
      action={
        <select value={a?.id ?? ''} onChange={(e) => setSel(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:outline-none">
          {list.length === 0 && <option value="">No VMs</option>}
          {list.map((x) => <option key={x.id} value={x.id}>{x.hostname ?? x.name}</option>)}
        </select>
      }
    >
      {!a ? (
        <div className="px-4 py-8 text-center text-2xs text-muted">No VMs enrolled yet. Add an agent above, or click <b className="text-white">🔌 Add agent</b> on an IP/Host monitor.</div>
      ) : (
        <div>
          <div className="grid grid-cols-2 gap-3 border-b border-border p-3 sm:grid-cols-4">
            <SvcMetric label="CPU" v={a.cpuPct} />
            <SvcMetric label="Memory" v={a.memPct} />
            <SvcMetric label="Disk" v={a.diskPct} />
            <SvcMetric label="Network" v={a.netMbps} raw />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-2xs">
            <span className={`rounded-full px-1.5 py-0.5 ${a.online ? 'bg-success/15 text-success' : 'bg-muted/20 text-muted'}`}>{a.online ? 'online' : 'offline'}</span>
            <span className="text-muted">{a.os ?? '—'} · {a.mode === 'ssh-pull' ? 'SSH pull' : a.outbound ? 'outbound (tunnel)' : 'push agent (legacy)'} · {a.lastSeenAt ? `seen ${timeAgo(a.lastSeenAt)}` : 'never'}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter services…" className="ml-auto w-32 rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:outline-none" />
            {canPull && a.mode === 'ssh-pull' && <button onClick={doPull} disabled={pull.isPending} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{pull.isPending ? 'Pulling…' : '↻ Pull now'}</button>}
          </div>
          {msg && <div className="border-b border-border-soft px-3 py-1 text-2xs text-brand">{msg}</div>}
          {hasUtil && (
            <div className="flex items-center gap-2 border-b border-border bg-card/40 px-4 py-1 text-2xs font-medium uppercase tracking-wide text-muted">
              <span className="flex-1">Service / process</span>
              <span className="w-14 text-right">CPU</span>
              <span className="w-20 text-right">Memory</span>
              <span className="w-16 text-right">Status</span>
            </div>
          )}
          <div className="max-h-72 overflow-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-2xs text-muted">{services.length === 0 ? 'No services reported yet — click Pull now or wait for the next cycle.' : 'No services match.'}</div>
            ) : (
              filtered.map((s, i) => (
                <div key={i} className="flex items-center gap-2 border-b border-border-soft px-4 py-1.5 text-2xs last:border-0">
                  <span className="flex-1 truncate text-white">{s.name}</span>
                  {hasUtil ? (
                    <>
                      <span className="w-14 text-right" style={{ color: s.cpu == null ? '#64748b' : utilColor(s.cpu) }}>{s.cpu == null ? '—' : `${s.cpu}%`}</span>
                      <span className="w-20 text-right" style={{ color: s.mem == null ? '#64748b' : utilColor(s.mem) }}>{s.mem == null ? '—' : `${s.mem}%`}</span>
                      <span className="flex w-16 shrink-0 items-center justify-end gap-1 text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />{s.status}</span>
                    </>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1 text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />{s.status}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function SvcMetric({ label, v, raw }: { label: string; v: number | null; raw?: boolean }) {
  const c = raw ? '#e2e8f0' : utilColor(v);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-2xs"><span className="text-muted">{label}</span><span className="font-medium tabular-nums" style={{ color: c }}>{v == null ? '—' : raw ? `${v.toFixed(1)} Mbps` : `${Math.round(v)}%`}</span></div>
      {!raw && <div className="h-1.5 w-full overflow-hidden rounded-full bg-border"><div className="h-full rounded-full" style={{ width: `${v ?? 0}%`, background: c }} /></div>}
    </div>
  );
}

function AiPanel({ incidents, alerts }: { incidents: { id: string; title: string }[]; alerts: { id: string; title: string }[] }) {
  const status = useAiStatus();
  const assistant = useAiAssistant();
  const rca = useRca();
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [rcaOut, setRcaOut] = useState<{ source: string; narrative: string; evidence: string[] } | null>(null);

  const ask = async () => {
    if (!q.trim()) return;
    setAnswer(null);
    try { const r = await assistant.mutateAsync(q.trim()); setAnswer(r.answer); }
    catch (e) { setAnswer((e as Error).message); }
  };
  const target = incidents[0] ?? alerts[0];
  const runRca = async () => {
    setRcaOut(null);
    try { setRcaOut(await rca.mutateAsync(incidents[0] ? { incidentId: incidents[0].id } : alerts[0] ? { alertId: alerts[0].id } : {})); }
    catch (e) { setRcaOut({ source: 'error', narrative: (e as Error).message, evidence: [] }); }
  };

  const llm = status.data?.llm;
  const providerLabel = status.data?.providerLabel ?? 'Free (built-in)';
  return (
    <Card title="AI Assistant & Root-Cause Analysis" action={<Badge color={llm ? '#22c55e' : '#3b82f6'} tone="dot">{llm ? `${providerLabel} · ${status.data?.model}` : providerLabel}</Badge>}>
      {!llm && <div className="mb-3 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2 text-2xs text-muted-light">Running the <b className="text-white">free built-in</b> assistant (MCMF navigation help + rule-based RCA). For AI-written answers, pick a provider — <b className="text-white">Claude, ChatGPT or Gemini</b> — in Settings → Integrations → AI Assistant.</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Assistant */}
        <div>
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Ask the assistant</div>
          <div className="flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} placeholder="e.g. How do I provision an Azure VM? Why is CPU high?" className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
            <button onClick={ask} disabled={assistant.isPending || !q.trim()} className="rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{assistant.isPending ? '…' : 'Ask'}</button>
          </div>
          {answer && <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-card/60 p-3 text-2xs text-muted-light">{answer}</div>}
        </div>
        {/* RCA */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted">Root-cause analysis</span>
            <button onClick={runRca} disabled={rca.isPending || !target} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-brand hover:text-white disabled:opacity-40">{rca.isPending ? 'Analyzing…' : target ? `Analyze: ${target.title.slice(0, 28)}` : 'No active incident'}</button>
          </div>
          {rcaOut ? (
            <div className="max-h-48 overflow-auto rounded-lg border border-border bg-card/60 p-3 text-2xs">
              <div className="mb-1 text-2xs text-muted">{rcaOut.source === 'llm' ? '✨ AI analysis' : rcaOut.source === 'rules' ? 'Rule-based correlation' : 'Error'}</div>
              <div className="whitespace-pre-wrap text-muted-light">{rcaOut.narrative}</div>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card/40 p-3 text-2xs text-muted">Correlates SIEM events, platform events and hot resources around the incident; AI writes the root cause when configured.</div>
          )}
        </div>
      </div>
    </Card>
  );
}

const inpCls = 'rounded border border-border bg-bg px-2 py-1 text-2xs text-white placeholder:text-muted focus:border-brand focus:outline-none';

function SshPullForm() {
  const { data: me } = useAuthUser();
  const enroll = useEnrollPull();
  const vms = useVms();
  const monitors = useMonitors();
  // Existing IP/Host Monitor groups (monitoring is group-based) — offered for the new target.
  // Same group taxonomy as IP/Host Monitor (distinct monitor groups); 'default' always available.
  const groups = [...new Set(['default', ...(monitors.data ?? []).map((m) => m.group).filter(Boolean)])].sort();
  const [newGroup, setNewGroup] = useState(false);
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<'ssh' | 'http'>('ssh');
  const [f, setF] = useState({ host: '', altHosts: '', port: '22', username: '', password: '', pullKey: '', intervalSec: '120', os: 'linux', group: 'default' });
  const [vmIps, setVmIps] = useState<{ label: string; ip: string }[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  // Deep-link: /command-center?enroll=1&host=<ip>&os=<os> (e.g. from the Zero-Trust workload dashboard)
  // opens this form pre-filled so the user can add the agent in one step.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.get('enroll')) return;
    const host = q.get('host') ?? '';
    const os = /win/i.test(q.get('os') ?? '') ? 'windows' : 'linux';
    setOpen(true);
    setF((cur) => ({ ...cur, host, os }));
    setTimeout(() => document.getElementById('ssh-pull-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
  }, []);
  const [msg, setMsg] = useState<string | null>(null);
  const setMethodAndPort = (m: 'ssh' | 'http') => { setMethod(m); setF((cur) => ({ ...cur, port: m === 'http' ? '9182' : '22' })); };
  if (me?.role !== 'admin') return null;
  // VMs discovered in Cloud Inventory with at least one IP.
  const discovered = (vms.data ?? []).filter((v) => v.publicIp || v.privateIp);

  const applySel = (ips: string[]) => { setSel(ips); setF((cur) => ({ ...cur, host: ips[0] ?? '', altHosts: ips.slice(1).join(',') })); };
  const pickVm = (id: string) => {
    const v = discovered.find((x) => x.id === id);
    if (!v) { setVmIps([]); return; }
    const ips: { label: string; ip: string }[] = [];
    if (v.publicIp) ips.push({ label: 'Public', ip: v.publicIp });
    if (v.privateIp) ips.push({ label: 'Private', ip: v.privateIp });
    setVmIps(ips);
    applySel(v.publicIp ? [v.publicIp] : ips.map((x) => x.ip).slice(0, 1));
    setF((cur) => ({ ...cur, os: /win/i.test(v.os) ? 'windows' : 'linux' }));
  };
  const toggleIp = (ip: string) => {
    const next = sel.includes(ip) ? sel.filter((x) => x !== ip) : [...sel, ip];
    applySel(vmIps.map((x) => x.ip).filter((x) => next.includes(x))); // keep public-before-private order
  };

  const submit = async () => {
    setMsg(null);
    if (!f.host) return setMsg('A VM IP is required');
    const group = (f.group || 'default').trim() || 'default';
    try {
      if (method === 'http') {
        const r = await enroll.mutateAsync({ host: f.host.trim(), altHosts: f.altHosts, port: Number(f.port) || 9182, mode: 'http-pull', pullKey: f.pullKey.trim() || undefined, intervalSec: Number(f.intervalSec) || 120, os: 'windows', group });
        setMsg(`Enrolled (agent pull) in group “${group}”. Use this key in the agent: ${r?.pullKey ?? f.pullKey}`);
      } else {
        if (!f.username || !f.password) return setMsg('IP, username and password are required');
        await enroll.mutateAsync({ host: f.host.trim(), altHosts: f.altHosts, port: Number(f.port) || 22, username: f.username.trim(), password: f.password, intervalSec: Number(f.intervalSec) || 120, os: f.os, group });
        setMsg(`Enrolled in group “${group}” — MCMF will pull over SSH and monitor reachability shortly.`);
      }
      setF({ host: '', altHosts: '', port: method === 'http' ? '9182' : '22', username: '', password: '', pullKey: '', intervalSec: '120', os: f.os, group }); setVmIps([]); setSel([]); setNewGroup(false);
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div id="ssh-pull-form" className="border-b border-border px-4 py-2">
      <button onClick={() => setOpen(!open)} className="text-2xs font-medium text-brand hover:underline">{open ? '− Hide' : '+ Add agent'}</button>
      {open && (
        <div className="mt-2 space-y-2">
          {msg && <div className="rounded border border-border bg-card/60 px-2 py-1 text-2xs text-muted-light">{msg}</div>}
          <div className="flex gap-1.5 text-2xs">
            <span className="text-muted">Method:</span>
            <button onClick={() => setMethodAndPort('ssh')} className={`rounded px-2 py-0.5 ${method === 'ssh' ? 'bg-brand text-white' : 'border border-border text-muted hover:text-white'}`}>Agent (SSH)</button>
            <button onClick={() => setMethodAndPort('http')} className={`rounded px-2 py-0.5 ${method === 'http' ? 'bg-brand text-white' : 'border border-border text-muted hover:text-white'}`}>Agent (.exe / TCP)</button>
          </div>
          {discovered.length > 0 && (
            <select onChange={(e) => { pickVm(e.target.value); e.currentTarget.selectedIndex = 0; }} defaultValue="" className={`w-full ${inpCls}`}>
              <option value="">⤓ Pick a discovered VM ({discovered.length})… or type the IP below</option>
              {discovered.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.publicIp ?? v.privateIp} · {v.provider.toUpperCase()} · {/win/i.test(v.os) ? 'Windows' : 'Linux'}</option>)}
            </select>
          )}
          {vmIps.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-card/40 px-2 py-1.5 text-2xs">
              <span className="text-muted">Pull from:</span>
              {vmIps.map((x) => (
                <label key={x.ip} className="flex items-center gap-1 text-white">
                  <input type="checkbox" checked={sel.includes(x.ip)} onChange={() => toggleIp(x.ip)} /> {x.label} <span className="font-mono text-muted-light">{x.ip}</span>
                </label>
              ))}
              <span className="text-muted">— MCMF tries each (failover)</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="Primary IP" className={inpCls} />
            <input value={f.altHosts} onChange={(e) => setF({ ...f, altHosts: e.target.value })} placeholder="Alternate IPs (optional, comma-sep)" className={inpCls} />
            <input value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} placeholder={method === 'http' ? 'Agent port (9182)' : 'SSH port (22)'} className={inpCls} />
            <input value={f.intervalSec} onChange={(e) => setF({ ...f, intervalSec: e.target.value })} placeholder="interval (s)" className={inpCls} />
            <label className="col-span-2 flex items-center gap-1.5 text-2xs text-muted">
              <span className="shrink-0">Monitor group:</span>
              {newGroup ? (
                <input autoFocus value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} placeholder="new group name" className={`flex-1 ${inpCls}`} />
              ) : (
                <select value={f.group} onChange={(e) => { if (e.target.value === '__new__') { setNewGroup(true); setF({ ...f, group: '' }); } else setF({ ...f, group: e.target.value }); }} className={`flex-1 ${inpCls}`}>
                  {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                  <option value="__new__">➕ New group…</option>
                </select>
              )}
              {newGroup && <button type="button" onClick={() => { setNewGroup(false); setF({ ...f, group: 'default' }); }} className="shrink-0 text-brand hover:underline">cancel</button>}
            </label>
            <div className="col-span-2 -mt-1 text-2xs text-muted">Shared with IP/Host Monitor — this VM appears there under the same group (TCP heartbeat on the agent port).</div>
            {method === 'ssh' ? (
              <>
                <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="SSH username" className={inpCls} />
                <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="SSH password" className={inpCls} />
                <select value={f.os} onChange={(e) => setF({ ...f, os: e.target.value })} className={`col-span-2 ${inpCls}`}>
                  <option value="linux">Linux (SSH)</option>
                  <option value="windows">Windows (OpenSSH — collects via PowerShell)</option>
                </select>
              </>
            ) : (
              <input value={f.pullKey} onChange={(e) => setF({ ...f, pullKey: e.target.value })} placeholder="Agent key (blank = auto-generate)" className={`col-span-2 ${inpCls}`} />
            )}
          </div>
          <button onClick={submit} disabled={enroll.isPending} className="rounded bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{enroll.isPending ? 'Enrolling…' : 'Enroll & pull'}</button>
          {method === 'http' && <div className="text-2xs text-muted">Agent pull: run the <b className="text-white">Windows agent (.exe / raw TCP)</b> script from Help → Agents & Infra on the VM with this key + port. MCMF opens a raw TCP socket to the VM (no HTTP/HTTPS) and pulls one JSON snapshot — works on any custom port.</div>}
          <div className="text-2xs text-muted">Pick a discovered VM to tick its <b className="text-white">public / private</b> IPs (MCMF tries each — use either), or type IP(s) manually. Set a <b className="text-white">custom SSH port</b> if you hardened the VM. MCMF connects out to the VM (no agent install, no inbound port to MCMF). Password sealed (AES-256-GCM).</div>
        </div>
      )}
    </div>
  );
}

function AgentRow({ a }: { a: CommandCenterOverview['agents'][number] }) {
  const { data: me } = useAuthUser();
  const update = useUpdateAgent();
  const remove = useRemoveAgent();
  const enqueue = useEnqueueAgentCommand();
  const push = useAgentPushAgent();
  const pull = useAgentPullNow();
  const isAdmin = me?.role === 'admin';
  const isPull = a.mode === 'ssh-pull';
  const isLinux = !/win/i.test(a.os ?? 'linux');
  const [editing, setEditing] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushPort, setPushPort] = useState('9182');
  const [pushUser, setPushUser] = useState('');
  const [pushPass, setPushPass] = useState('');
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [e, setE] = useState({ displayName: a.displayName ?? '', group: a.group ?? 'default', host: a.hostname ?? '', altHosts: a.altHosts ?? '', port: String(a.port ?? 22), username: '', password: '', os: a.os ?? 'linux' });
  const monitors = useMonitors();
  const [newGroup, setNewGroup] = useState(false);
  // Shared scope taxonomy (same groups as IP/Host Monitor, Network Devices and the Add-agent form) so the
  // edit form lets you MOVE the agent into any existing scope, not just retype a name.
  const groups = [...new Set(['default', ...(monitors.data ?? []).map((m) => m.group).filter(Boolean), e.group].filter(Boolean))].sort();
  const saveEdit = () => {
    // Display name + group apply to every agent; SSH host/port/creds only to pull (agentless) agents.
    const body: Record<string, unknown> = { id: a.id, displayName: e.displayName.trim(), group: e.group.trim() || 'default' };
    if (isPull) Object.assign(body, { host: e.host.trim(), altHosts: e.altHosts, port: Number(e.port) || 22, username: e.username.trim() || undefined, password: e.password || undefined, os: e.os });
    update.mutate(body as any);
    setEditing(false);
  };
  const doPush = async () => {
    setPushMsg(null);
    try {
      const r = await push.mutateAsync({ id: a.id, port: Number(pushPort) || 9182, username: pushUser.trim() || undefined, password: pushPass || undefined });
      setPushMsg({ ok: r.verified, text: r.message });
      setPushOpen(false); setPushPass('');
    } catch (err) { setPushMsg({ ok: false, text: (err as Error).message }); }
  };
  const doTest = async () => {
    setPushMsg({ ok: true, text: 'Testing agent…' });
    try {
      const r = await pull.mutateAsync(a.id);
      setPushMsg({ ok: r?.reachable !== false, text: r?.message ?? 'Pulled fresh telemetry ✓' });
    } catch (err) { setPushMsg({ ok: false, text: (err as Error).message }); }
  };
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {/* Name on its own line so it shows fully; the badges wrap on the line below instead of squeezing it. */}
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: a.online ? '#22c55e' : '#64748b' }} />
            <span className="truncate text-sm font-medium text-white" title={a.machineName && a.machineName !== a.name ? `${a.name} · host: ${a.machineName}` : a.name}>{a.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-border/40 px-1.5 text-2xs text-muted">{isPull ? 'agent (SSH)' : 'agent'}</span>
            {!isPull && (a.outbound ? <span className="rounded bg-emerald-500/15 px-1.5 text-2xs text-emerald-300" title="Pure-outbound agent — dials home over HTTPS, supports the console tunnel. No inbound port.">⇡ outbound ✓</span> : <span className="rounded bg-amber-500/15 px-1.5 text-2xs text-amber-300" title="Legacy push agent — no console tunnel. Re-run the installer to switch to outbound.">push (legacy)</span>)}
            {a.group && <a href="/monitoring" title="Monitor group (shared with IP/Host Monitor)" className="rounded bg-brand/15 px-1.5 text-2xs text-brand hover:bg-brand/25">⊟ {a.group}</a>}
            {a.version && <span className={`rounded px-1.5 text-2xs ${a.outdated ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`} title={a.outdated ? `Agent v${a.version} — server has v${a.currentVersion}. Use "Update agent" to push the latest.` : `Up to date (v${a.version})`}>v{a.version}{a.outdated ? ' · update available' : ' ✓ latest'}</span>}
            {a.port && a.port !== 22 && <span className="rounded bg-border/40 px-1.5 text-2xs text-muted">:{a.port}</span>}
            <span className={`rounded px-1.5 text-2xs ${a.online ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>{a.online ? '● Running' : '● Not running'}</span>
            {!a.active && <span className="rounded bg-danger/15 px-1.5 text-2xs text-danger">decommissioning</span>}
          </div>
          <div className="text-2xs text-muted">{a.services} services · every {a.intervalSec}s · {a.lastSeenAt ? timeAgo(a.lastSeenAt) : 'never'}{a.altHosts ? ` · +${a.altHosts.split(',').filter(Boolean).length} IP` : ''}</div>
          {a.loggedInUser && <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs"><span className="rounded bg-brand/15 px-1.5 text-brand">👤 {a.loggedInUser}</span>{a.posture && <Posture posture={a.posture} />}</div>}
        </div>
        <div className="flex shrink-0 gap-3 text-2xs">
          <Telem label="CPU" v={a.cpuPct} /><Telem label="Mem" v={a.memPct} /><Telem label="Disk" v={a.diskPct} />
        </div>
      </div>
      {isAdmin && !a.online && a.active && (
        <div className="mt-1.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 rounded border border-danger/30 bg-danger/5 px-2 py-1 text-2xs text-danger">
            <span>Agent not responding{a.lastSeenAt ? ` — last reported ${timeAgo(a.lastSeenAt)}` : ' — no telemetry received yet'}.</span>
            {isLinux
              ? <button onClick={() => setPushOpen(!pushOpen)} className="ml-auto rounded border border-brand/50 bg-brand/15 px-2 py-0.5 font-medium text-brand hover:bg-brand/25" title="Re-install a fresh agent on this Linux host over SSH, then pull from it">{pushOpen ? 'Cancel' : '⤓ Push new agent'}</button>
              : <span className="ml-auto flex items-center gap-2">
                  <button onClick={doTest} disabled={pull.isPending} className="rounded border border-brand/50 bg-brand/15 px-2 py-0.5 font-medium text-brand hover:bg-brand/25 disabled:opacity-50" title="Try to reach this agent's listener and pull fresh telemetry — confirms whether it's alive">{pull.isPending ? 'Testing…' : '⟳ Test'}</button>
                  <button onClick={() => setPushOpen(!pushOpen)} className="rounded border border-brand/50 bg-brand/15 px-2 py-0.5 font-medium text-brand hover:bg-brand/25" title="Remotely re-install the always-on agent over SSH (OpenSSH on the host), or get the installer from Help">{pushOpen ? 'Cancel' : '↧ Reinstall'}</button>
                </span>}
          </div>
          {pushOpen && (
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-brand/30 bg-brand/[0.04] p-2 text-2xs">
              <input value={pushUser} onChange={(ev) => setPushUser(ev.target.value)} placeholder={isLinux ? 'SSH username (blank = use saved)' : 'Windows admin username (blank = use saved)'} className={inpCls} />
              <input type="password" value={pushPass} onChange={(ev) => setPushPass(ev.target.value)} placeholder="Password (blank = use saved)" className={inpCls} />
              <input value={pushPort} onChange={(ev) => setPushPort(ev.target.value)} placeholder="Agent TCP port (9182)" className={inpCls} />
              <button onClick={doPush} disabled={push.isPending} className="rounded bg-brand px-2.5 py-1 font-medium text-white hover:bg-brand-soft disabled:opacity-50">{push.isPending ? 'Installing…' : '⤓ Install fresh agent'}</button>
              {isLinux
                ? <div className="col-span-2 text-2xs text-muted">MCMF SSHes in and installs a new agent, then pulls from it. For an <b className="text-white">SSH-pull</b> target leave the login blank (uses the saved password); for a <b className="text-white">push/TCP</b> agent with no saved SSH login, enter one.</div>
                : <div className="col-span-2 text-2xs text-muted">MCMF connects over <b className="text-white">SSH (OpenSSH, TCP {a.port || 22})</b> with a <b className="text-white">local-admin</b> login and installs the always-on service + tray. Leave blank to use the saved credential; otherwise enter one. The host must have OpenSSH Server enabled and be reachable — if not, download the installer from <a href="/help" className="text-brand hover:underline">Help → Agents</a> and run it locally.</div>}
            </div>
          )}
        </div>
      )}
      {isAdmin && (
        <div className="mt-1.5 flex items-center gap-2 text-2xs">
          <span className="text-muted">interval</span>
          {[30, 60, 300].map((s) => (
            <button key={s} onClick={() => update.mutate({ id: a.id, intervalSec: s })} className={`rounded px-1.5 py-0.5 ${a.intervalSec === s ? 'bg-brand text-white' : 'border border-border text-muted hover:text-white'}`}>{s}s</button>
          ))}
          {!isPull && <button onClick={doTest} disabled={pull.isPending} className="ml-auto rounded border border-brand/50 bg-brand/10 px-1.5 py-0.5 text-brand hover:bg-brand/20 disabled:opacity-50" title="Reach the agent's listener and pull fresh telemetry now (Windows/endpoint agents also listen for a pull)">{pull.isPending ? 'Testing…' : '⟳ Test'}</button>}
          {isPull && isLinux && (
            <>
              <input value={pushPort} onChange={(ev) => setPushPort(ev.target.value)} className="ml-auto w-14 rounded border border-border bg-bg px-1.5 py-0.5 text-2xs text-white focus:border-brand focus:outline-none" title="Agent TCP port" />
              <button onClick={doPush} disabled={push.isPending} className="rounded border border-brand/50 bg-brand/10 px-1.5 py-0.5 text-brand hover:bg-brand/20 disabled:opacity-50" title="Install the guest agent on this Linux host over SSH, then pull from it">{push.isPending ? 'Pushing…' : '⤓ Push agent'}</button>
            </>
          )}
          <button onClick={() => setEditing(!editing)} className={`rounded px-1.5 py-0.5 text-brand hover:underline ${isPull && isLinux ? '' : 'ml-auto'}`}>{editing ? 'Close' : '✎ Edit'}</button>
          {!isPull && <button onClick={() => { if (confirm(`Push the latest agent to "${a.hostname ?? a.name}"?\n\nThe agent downloads + clean-upgrades itself on its next check-in (no reinstall needed).`)) enqueue.mutate({ id: a.id, kind: 'update' }); }} disabled={enqueue.isPending} className={`rounded px-1.5 py-0.5 hover:underline disabled:opacity-50 ${a.outdated ? 'bg-amber-500/15 px-2 font-medium text-amber-300' : 'text-brand'}`} title={a.outdated ? `Agent is v${a.version} — server has v${a.currentVersion}. Push the update.` : 'Remotely push the latest agent — it self-updates'}>{enqueue.isPending ? 'Pushing…' : a.outdated ? '⟳ Update available' : '⟳ Update agent'}</button>}
          <button onClick={() => confirm(`Remove agent "${a.hostname ?? a.name}" from the list (does not uninstall it)?`) && remove.mutate(a.id)} className="rounded px-1.5 py-0.5 text-danger hover:underline">Remove</button>
        </div>
      )}
      {pushMsg && <div className={`mt-1.5 rounded border px-2 py-1 text-2xs ${pushMsg.ok ? 'border-success/40 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning'}`}>{pushMsg.text}</div>}
      {isAdmin && editing && (
        <div className="mt-2 space-y-2 rounded-lg border border-brand/30 bg-brand/[0.04] p-2">
          <div className="text-2xs font-semibold text-brand">✎ Edit agent</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-0.5 block text-2xs text-muted">Display name <span className="text-muted/70">— shared with the IP/Host monitor</span></label>
              <input value={e.displayName} onChange={(ev) => setE({ ...e, displayName: ev.target.value })} placeholder={a.machineName ?? 'Agent name'} className={`w-full ${inpCls}`} />
            </div>
            <div>
              <label className="mb-0.5 block text-2xs text-muted">Group / scope <span className="text-muted/70">— moves the agent &amp; its monitor</span></label>
              {newGroup ? (
                <div className="flex items-center gap-1">
                  <input autoFocus value={e.group} onChange={(ev) => setE({ ...e, group: ev.target.value })} placeholder="new group name" className={`flex-1 ${inpCls}`} />
                  <button type="button" onClick={() => { setNewGroup(false); setE({ ...e, group: a.group ?? 'default' }); }} className="shrink-0 text-2xs text-brand hover:underline">cancel</button>
                </div>
              ) : (
                <select value={e.group} onChange={(ev) => { if (ev.target.value === '__new__') { setNewGroup(true); setE({ ...e, group: '' }); } else setE({ ...e, group: ev.target.value }); }} className={`w-full ${inpCls}`}>
                  {groups.map((gx) => <option key={gx} value={gx}>{gx}</option>)}
                  <option value="__new__">➕ New group…</option>
                </select>
              )}
            </div>
          </div>
          {isPull && (
            <div className="grid grid-cols-2 gap-2 border-t border-border-soft pt-2">
              <input value={e.host} onChange={(ev) => setE({ ...e, host: ev.target.value })} placeholder="Primary IP" className={inpCls} />
              <input value={e.altHosts} onChange={(ev) => setE({ ...e, altHosts: ev.target.value })} placeholder="Alternate IPs (comma-sep)" className={inpCls} />
              <input value={e.port} onChange={(ev) => setE({ ...e, port: ev.target.value })} placeholder="SSH port" className={inpCls} />
              <select value={e.os} onChange={(ev) => setE({ ...e, os: ev.target.value })} className={inpCls}>
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </select>
              <input value={e.username} onChange={(ev) => setE({ ...e, username: ev.target.value })} placeholder="SSH username (blank = keep)" className={inpCls} />
              <input type="password" value={e.password} onChange={(ev) => setE({ ...e, password: ev.target.value })} placeholder="SSH password (blank = keep)" className={inpCls} />
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveEdit} disabled={update.isPending || (isPull && !e.host)} className="rounded bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{update.isPending ? 'Saving…' : 'Save changes'}</button>
            <button onClick={() => setEditing(false)} className="rounded border border-border px-2.5 py-1 text-2xs text-muted hover:text-white">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Telem({ label, v }: { label: string; v: number | null }) {
  const val = v ?? 0;
  const color = val >= 85 ? '#ef4444' : val >= 60 ? '#f59e0b' : '#22c55e';
  return <span className="text-right"><span className="text-muted">{label} </span><span style={{ color }}>{v == null ? '—' : `${val}%`}</span></span>;
}

/** Endpoint device posture chips (for the AAA / NAC step): firewall, AV, encryption, patch state. */
function Posture({ posture }: { posture: Record<string, unknown> }) {
  const chip = (label: string, ok: boolean | null) => {
    if (ok == null) return null;
    return <span key={label} className={`rounded px-1.5 text-2xs ${ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>{ok ? '✓' : '✕'} {label}</span>;
  };
  const b = (k: string): boolean | null => (typeof posture[k] === 'boolean' ? (posture[k] as boolean) : null);
  return (
    <>
      {chip('Firewall', b('firewallOn'))}
      {chip('AV', b('antivirusOn'))}
      {chip('Encrypted', b('diskEncrypted'))}
      {b('pendingReboot') === true && <span className="rounded bg-warning/15 px-1.5 text-2xs text-warning">⟳ reboot pending</span>}
      {b('domainJoined') === true && <span className="rounded bg-border/40 px-1.5 text-2xs text-muted">domain</span>}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 py-2">
      <div className="text-base font-semibold text-white">{number(value)}</div>
      <div className="text-2xs text-muted">{label}</div>
    </div>
  );
}
