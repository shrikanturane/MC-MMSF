'use client';

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui';
import { PasswordInput } from '@/components/PasswordInput';
import { useCheckMonitors, useCreateMonitor, useUpdateMonitor, useDeleteMonitor, useMonitors, useAgents, useVms, useEnrollPull, type AgentInfo } from '@/lib/hooks';
import { useAuthUser } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import type { MonitorItem } from '@/lib/types';

const STATUS_COLOR: Record<string, string> = { up: '#22c55e', down: '#ef4444', unknown: '#64748b' };

/** Color a 0–100 utilization metric: green < 70, amber < 90, red ≥ 90. */
const metricColor = (v: number) => (v >= 90 ? '#ef4444' : v >= 70 ? '#f59e0b' : '#22c55e');

/** Normalize a monitor target (strip scheme/port/path) to a bare host for agent matching. */
function bareHost(target: string): string {
  let t = (target || '').trim().toLowerCase();
  t = t.replace(/^[a-z]+:\/\//, ''); // scheme
  t = t.split('/')[0]; // path
  t = t.replace(/:\d+$/, ''); // port
  return t;
}

/** Protocol presets (mirror the API's PROTOCOLS map) — picking one fills the right port. */
const PRESETS: { type: string; label: string; port?: number; portless?: boolean }[] = [
  { type: 'agent', label: 'Agent (heartbeat — reachable while sending data)', portless: true },
  { type: 'ping', label: 'ICMP Ping', portless: true },
  { type: 'http', label: 'HTTP(S)', portless: true },
  { type: 'tcp', label: 'TCP port', port: 80 },
  { type: 'ssh', label: 'SSH', port: 22 },
  { type: 'rdp', label: 'RDP (Remote Desktop)', port: 3389 },
  { type: 'telnet', label: 'Telnet', port: 23 },
  { type: 'https', label: 'HTTPS / TLS', port: 443 },
  { type: 'smtp', label: 'SMTP', port: 25 },
  { type: 'dns', label: 'DNS', port: 53 },
  { type: 'redfish', label: 'Redfish (BMC / iDRAC / iLO)', port: 443 },
  { type: 'snmp', label: 'SNMP', port: 161 },
];
const PRESET = (t: string) => PRESETS.find((p) => p.type === t);
const TYPE_LABEL = (t: string) => PRESET(t)?.label ?? t;

const CHART_OPTS: [string, string][] = [
  ['line', 'Latency · Line'],
  ['area', 'Latency · Area'],
  ['bars', 'Latency · Bars'],
  ['availability', 'Availability'],
  ['gauge', 'Resources · Gauges'],
  ['resbars', 'Resources · Bars'],
];

const inputCls = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none';
const emptyF = { name: '', target: '', altTargets: '', type: 'ssh', port: '22', group: 'default', deviceKind: 'host', snmpCommunity: '' };
const DEVICE_KINDS: [string, string][] = [['host', 'Host / Server'], ['firewall', 'Firewall'], ['router', 'Router'], ['switch', 'Switch'], ['server', 'Server'], ['other', 'Other device']];

export function IpMonitorPanel({
  embedded = false,
  scope = '',
  chartType = 'line',
  onConfig,
}: {
  embedded?: boolean;
  scope?: string; // pin this widget to one group ('' = centralized / all groups)
  chartType?: string;
  onConfig?: (patch: { group?: string; chart?: string }) => void;
}) {
  const monitors = useMonitors();
  const agents = useAgents();
  const vms = useVms();
  const create = useCreateMonitor();
  const update = useUpdateMonitor();
  const del = useDeleteMonitor();
  const check = useCheckMonitors();
  const enroll = useEnrollPull();
  const { data: me } = useAuthUser();
  const canEdit = me?.role === 'admin' || me?.role === 'operator';

  // One-click SSH-pull enroll for a monitored IP (attach credentials → MCMF pulls metrics).
  const [enrollId, setEnrollId] = useState<string | null>(null);
  const [enrollF, setEnrollF] = useState({ os: 'linux', port: '22', username: '', password: '' });
  const [enrollMsg, setEnrollMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const openEnroll = (m: MonitorItem) => {
    setEnrollId(m.id);
    setEnrollF({ os: m.type === 'rdp' ? 'windows' : 'linux', port: m.type === 'rdp' ? '22' : '22', username: '', password: '' });
    setEnrollMsg(null);
  };
  const submitEnroll = async (m: MonitorItem) => {
    if (!enrollF.username || !enrollF.password) { setEnrollMsg({ id: m.id, ok: false, text: 'Username and password required.' }); return; }
    try {
      await enroll.mutateAsync({ host: bareHost(m.target), port: Number(enrollF.port) || 22, username: enrollF.username, password: enrollF.password, os: enrollF.os, group: m.group });
      setEnrollMsg({ id: m.id, ok: true, text: 'Enrolled — MCMF will pull CPU/mem/disk over SSH on the next cycle.' });
      setEnrollId(null);
    } catch (e) {
      setEnrollMsg({ id: m.id, ok: false, text: (e as Error).message });
    }
  };

  // Match a monitor → a guest agent to surface CPU/mem/disk: by IP, hostname, OR a shared NAME
  // (the monitor's name == the agent's display name / hostname links the two).
  const agentFor = useMemo(() => {
    const byIp = new Map<string, AgentInfo>();
    const byHost = new Map<string, AgentInfo>();
    const byName = new Map<string, AgentInfo>();
    const key = (s?: string | null) => (s ?? '').trim().toLowerCase();
    for (const a of agents.data ?? []) {
      for (const ip of a.ips) byIp.set(key(ip), a);
      if (a.hostname) byHost.set(key(a.hostname), a);
      if (a.name) byName.set(key(a.name), a);
      if (a.displayName) byName.set(key(a.displayName), a);
      if (a.machineName) byName.set(key(a.machineName), a);
    }
    return (target: string, name?: string): AgentInfo | undefined => {
      const h = key(bareHost(target));
      return byIp.get(h) ?? byHost.get(h) ?? (name ? byName.get(key(name)) : undefined) ?? byName.get(h);
    };
  }, [agents.data]);
  // Agent names available to link a monitor to (used by the name field's datalist).
  const agentNames = useMemo(() => {
    const s = new Set<string>();
    for (const a of agents.data ?? []) { if (a.name) s.add(a.name); if (a.displayName) s.add(a.displayName); }
    return [...s].sort();
  }, [agents.data]);
  // Existing hosts you can monitor in one pick: agent-installed hosts + discovered VMs.
  // Picking one fills the (shared) name + target so the monitor links straight back to that system.
  const hostPicks = useMemo(() => {
    const picks: { key: string; label: string; name: string; target: string; hasAgent: boolean }[] = [];
    const agentIps = new Set<string>();
    for (const a of agents.data ?? []) {
      const ip = (a.ips ?? [])[0] || a.hostname || '';
      (a.ips ?? []).forEach((x) => agentIps.add(x.trim().toLowerCase()));
      picks.push({ key: `agent:${a.id}`, label: `🛡 ${a.name}${ip ? ` · ${ip}` : ''} — agent (sending data)`, name: a.name, target: ip || a.name, hasAgent: true });
    }
    for (const v of vms.data ?? []) {
      const ip = v.publicIp || v.privateIp || '';
      if (!ip) continue;
      const hasAgent = agentIps.has(ip.trim().toLowerCase());
      picks.push({ key: `vm:${v.id}`, label: `🖥 ${v.name} · ${ip} — ${v.provider}${hasAgent ? ' · agent' : ''}`, name: v.name, target: ip, hasAgent });
    }
    return picks;
  }, [agents.data, vms.data]);

  const [q, setQ] = useState('');
  // In the full page (not a board widget) the user picks the expanded-row chart type here.
  const [localChart, setLocalChart] = useState(chartType);
  const effChart = onConfig ? chartType : localChart;
  const [sort, setSort] = useState<'name' | 'status' | 'latency' | 'group'>('group');
  const [grouped, setGrouped] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [f, setF] = useState({ ...emptyF, group: scope || 'default' });
  const [newGroup, setNewGroup] = useState(false);

  const pickType = (type: string) => {
    const p = PRESET(type);
    setF((cur) => ({ ...cur, type, port: p?.portless ? '' : String(p?.port ?? cur.port) }));
  };

  const allGroups = useMemo(() => [...new Set((monitors.data ?? []).map((m) => m.group))].sort(), [monitors.data]);

  const openNew = () => { setEditId(null); setF({ ...emptyF, group: scope || 'default' }); setShowForm(true); };
  const startEdit = (m: MonitorItem) => {
    setEditId(m.id);
    setF({ name: m.name, target: m.target, altTargets: m.altTargets ?? '', type: m.type, port: m.port != null ? String(m.port) : '', group: m.group, deviceKind: m.deviceKind ?? 'host', snmpCommunity: m.snmpCommunity ?? '' });
    setShowForm(true);
  };
  const closeForm = () => { setShowForm(false); setEditId(null); };

  const submit = () => {
    if (!f.name || !f.target) return;
    const body = { name: f.name, target: f.target, altTargets: f.altTargets, type: f.type, port: f.port ? Number(f.port) : undefined, group: f.group || 'default', deviceKind: f.deviceKind, snmpCommunity: f.snmpCommunity.trim() };
    if (editId) update.mutate({ id: editId, ...body });
    else create.mutate(body);
    closeForm();
  };

  const list = useMemo(() => {
    let rows = (monitors.data ?? []).filter((m) => !scope || m.group === scope);
    const t = q.toLowerCase();
    rows = rows.filter((m) => !t || m.name.toLowerCase().includes(t) || m.target.toLowerCase().includes(t) || m.group.toLowerCase().includes(t));
    const order: Record<string, number> = { down: 0, unknown: 1, up: 2 };
    rows = [...rows].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'status') return (order[a.status] ?? 3) - (order[b.status] ?? 3);
      if (sort === 'latency') return (a.lastLatencyMs ?? 1e9) - (b.lastLatencyMs ?? 1e9);
      return a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
    });
    return rows;
  }, [monitors.data, q, sort, scope]);

  // When pinned to a group, never show group headers (single group).
  const showGroups = grouped && !scope;
  const groups = useMemo<[string, MonitorItem[]][]>(() => {
    if (!showGroups) return [['', list]];
    const map = new Map<string, MonitorItem[]>();
    for (const m of list) {
      if (!map.has(m.group)) map.set(m.group, []);
      map.get(m.group)!.push(m);
    }
    return [...map.entries()];
  }, [list, showGroups]);

  const counts = useMemo(() => {
    const d = list;
    return { total: d.length, up: d.filter((m) => m.status === 'up').length, down: d.filter((m) => m.status === 'down').length };
  }, [list]);

  const title = scope ? `IP / Host Monitor · ${scope}` : 'IP / Host Monitor';

  const body = (
    <>
      {/* Scope + chart controls — only when hosted as a board widget */}
      {onConfig && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-bg/30 px-3 py-2">
          <label className="flex items-center gap-1.5 text-2xs text-muted">
            <span>Scope</span>
            <select value={scope} onChange={(e) => onConfig({ group: e.target.value })} className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:border-brand focus:outline-none">
              <option value="">All groups (centralized)</option>
              {allGroups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-2xs text-muted">
            <span>Chart</span>
            <select value={chartType} onChange={(e) => onConfig({ chart: e.target.value })} className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:border-brand focus:outline-none">
              {CHART_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <span className="ml-auto rounded-full border border-border bg-card px-2 py-0.5 text-2xs text-muted">{scope ? `isolated · ${scope}` : 'centralized'}</span>
        </div>
      )}

      {showForm && canEdit && (
        <div className="space-y-2 border-b border-border bg-brand/[0.04] p-3">
          {editId && <div className="text-2xs font-semibold text-brand">✎ Editing monitor</div>}
          {!editId && hostPicks.length > 0 && (
            <select value="" onChange={(e) => { const p = hostPicks.find((x) => x.key === e.target.value); if (p) setF({ ...f, name: p.name, target: p.target, type: p.hasAgent ? 'agent' : f.type, port: p.hasAgent ? '' : f.port }); }} title="Monitor an existing agent host or VM — fills the name + IP. A host with an agent defaults to the Agent (heartbeat) protocol so it's reachable while sending data. Or type a new device below." className={`w-full ${inputCls}`}>
              <option value="">➕ Pick an agent host or VM to monitor… (or type a new device below)</option>
              <optgroup label="Agent-installed hosts">{hostPicks.filter((p) => p.key.startsWith('agent:')).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</optgroup>
              <optgroup label="Discovered VMs">{hostPicks.filter((p) => p.key.startsWith('vm:')).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</optgroup>
            </select>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name (shared with Guest Agent)" list="mcmf-agent-names" title="The name is shared across VMs, agents and monitors — use the same name as a Guest Agent to link them; the agent's CPU/memory/disk then show on this monitor." className={inputCls} />
            <datalist id="mcmf-agent-names">{agentNames.map((n) => <option key={n} value={n} />)}</datalist>
            <input value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder="IP / host / URL" className={inputCls} />
            {newGroup ? (
              <div className="flex items-center gap-1">
                <input autoFocus value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} placeholder="new group name" className={inputCls} />
                <button type="button" onClick={() => { setNewGroup(false); setF({ ...f, group: 'default' }); }} className="shrink-0 text-2xs text-brand hover:underline">cancel</button>
              </div>
            ) : (
              <select value={f.group} onChange={(e) => { if (e.target.value === '__new__') { setNewGroup(true); setF({ ...f, group: '' }); } else setF({ ...f, group: e.target.value }); }} className={`${inputCls} cursor-pointer`} title="Monitor group — shared with Guest Agents">
                {[...new Set(['default', ...allGroups])].sort().map((g) => <option key={g} value={g}>{g}</option>)}
                <option value="__new__">➕ New group…</option>
              </select>
            )}
            <select value={f.type} onChange={(e) => pickType(e.target.value)} className={`${inputCls} cursor-pointer`}>
              {PRESETS.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
            </select>
            {!PRESET(f.type)?.portless && <input value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} placeholder="Port" className={inputCls} />}
            <select value={f.deviceKind} onChange={(e) => setF({ ...f, deviceKind: e.target.value })} className={`${inputCls} cursor-pointer`} title="Device type">
              {DEVICE_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {f.deviceKind !== 'host' && (
              <input value={f.snmpCommunity} onChange={(e) => setF({ ...f, snmpCommunity: e.target.value })} placeholder="SNMP community (e.g. public) — enables telemetry" className={`${inputCls} col-span-2`} />
            )}
            <input value={f.altTargets} onChange={(e) => setF({ ...f, altTargets: e.target.value })} placeholder="Alternate IPs (optional, e.g. public, private)" className={`${inputCls} col-span-2 sm:col-span-2`} />
            <button onClick={submit} disabled={create.isPending || update.isPending || !f.name || !f.target} className="rounded-md bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{editId ? 'Save changes' : 'Add monitor'}</button>
          </div>
          <div className="text-2xs text-muted">Monitors any device — servers, <b className="text-white">routers, switches, firewalls</b> — via ICMP ping, TCP port, HTTP(S) or SNMP. Pick a <b className="text-white">device type</b> and add the <b className="text-white">SNMP community</b> to pull <b className="text-white">bandwidth per interface, uptime, link up/down alerts</b> and the <b className="text-white">connected-device MAC table</b> (ARP + switch FDB). Latency &amp; jitter come from ICMP. Add <b className="text-white">Alternate IPs</b> for failover. For server CPU/mem/disk, use <b className="text-white">🔌 Add agent</b>.</div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-2xs">
          <span className="inline-flex items-center gap-1 rounded bg-success/15 px-1.5 py-0.5 font-medium text-success">{counts.up} up</span>
          <span className="inline-flex items-center gap-1 rounded bg-danger/15 px-1.5 py-0.5 font-medium text-danger">{counts.down} down</span>
        </span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / IP…" className="w-36 rounded-md border border-border bg-bg px-2.5 py-1 text-2xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        <select value={sort} onChange={(e) => setSort(e.target.value as any)} className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:border-brand focus:outline-none">
          <option value="group">Sort: Group</option>
          <option value="name">Sort: Name</option>
          <option value="status">Sort: Status</option>
          <option value="latency">Sort: Latency</option>
        </select>
        {!scope && <label className="flex items-center gap-1 text-2xs text-muted"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> group</label>}
        {!onConfig && (
          <label className="flex items-center gap-1 text-2xs text-muted" title="Chart shown when you expand a monitor">📊
            <select value={localChart} onChange={(e) => setLocalChart(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:border-brand focus:outline-none">
              {CHART_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        <button onClick={() => check.mutate()} disabled={check.isPending} className="ml-auto rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white disabled:opacity-50">{check.isPending ? 'Checking…' : 'Check now'}</button>
        {canEdit && <button onClick={() => (showForm ? closeForm() : openNew())} className={`rounded-md px-2.5 py-1 text-2xs font-medium transition ${showForm ? 'border border-border bg-card text-muted hover:text-white' : 'bg-brand text-white hover:bg-brand-soft'}`}>{showForm ? 'Close' : '+ Add'}</button>}
      </div>

      <div className={embedded ? 'min-h-0 flex-1 overflow-y-auto' : 'max-h-80 overflow-y-auto'}>
        {counts.total === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted">
            {scope ? <>No monitors in group <b className="text-white">{scope}</b>.</> : <>No monitors yet.</>} {canEdit && <>Click <b className="text-white">+ Add</b> to watch an IP / host.</>}
          </div>
        )}
        {groups.map(([g, rows]) => (
          <div key={g || 'all'}>
            {showGroups && <div className="flex items-center justify-between bg-bg/40 px-4 py-1 text-2xs font-semibold uppercase tracking-wide text-muted"><span>{g}</span><span>{rows.length}</span></div>}
            {rows.map((m) => {
              const allIps = [m.target, ...String(m.altTargets ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
              const agent = allIps.map((ip) => agentFor(ip)).find(Boolean) ?? agentFor(m.target, m.name);
              return (
              <div key={m.id} className="border-b border-border-soft last:border-0">
                <div className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-card-hover">
                  <button onClick={() => setDetailId(detailId === m.id ? null : m.id)} className="flex min-w-0 items-center gap-2.5 text-left">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[m.status], boxShadow: m.status === 'up' ? '0 0 6px #22c55e88' : m.status === 'down' ? '0 0 6px #ef444488' : 'none' }} title={m.status} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-white">{m.name}</span>
                        {agent && <span className="shrink-0 rounded bg-brand/15 px-1 text-[9px] font-semibold uppercase text-brand" title={`Agent: ${agent.name}${agent.online ? ' · online' : ' · offline'}`}>agent</span>}
                      </span>
                      <span className="block truncate font-mono text-2xs text-muted">{m.target}{m.port ? `:${m.port}` : ''} · {TYPE_LABEL(m.type)}{allIps.length > 1 ? ` · +${allIps.length - 1} IP` : ''}{m.lastAddress && m.lastAddress !== m.target ? ` · via ${m.lastAddress}` : ''}</span>
                    </span>
                  </button>
                  <div className="flex items-center gap-2.5">
                    {agent && <AgentMini a={agent} />}
                    <Uptime history={m.history} />
                    <span className="w-12 text-right text-2xs" style={{ color: STATUS_COLOR[m.status] }}>{m.status === 'up' ? `${m.lastLatencyMs ?? '-'} ms` : m.status === 'down' ? 'down' : '—'}</span>
                    <button onClick={() => setDetailId(detailId === m.id ? null : m.id)} className="text-2xs text-muted hover:text-white" title="Telemetry">{detailId === m.id ? '▾' : '▸'}</button>
                    {canEdit && !agent && <button onClick={() => (enrollId === m.id ? setEnrollId(null) : openEnroll(m))} className="rounded border border-border bg-card px-1.5 py-0.5 text-2xs text-brand hover:text-white" title="Add agent (SSH) — MCMF pulls CPU/mem/disk from this host">🔌 Add agent</button>}
                    {canEdit && <button onClick={() => startEdit(m)} className="text-2xs text-muted hover:text-white" title="Edit monitor">✎</button>}
                    {canEdit && <button onClick={() => del.mutate(m.id)} className="text-2xs text-danger hover:underline" title="Delete monitor">✕</button>}
                  </div>
                </div>
                {enrollId === m.id && (
                  <div className="space-y-2 border-t border-border-soft bg-brand/[0.04] px-4 py-3">
                    <div className="text-2xs text-muted">Attach SSH credentials so MCMF pulls CPU/memory/disk from <span className="font-mono text-white">{bareHost(m.target)}</span>. The host must allow inbound TCP 22 from the MCMF server.</div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <select value={enrollF.os} onChange={(e) => setEnrollF({ ...enrollF, os: e.target.value })} className={inputCls}>
                        <option value="linux">Linux</option>
                        <option value="windows">Windows (OpenSSH)</option>
                      </select>
                      <input value={enrollF.port} onChange={(e) => setEnrollF({ ...enrollF, port: e.target.value })} placeholder="SSH port (22)" className={inputCls} />
                      <input value={enrollF.username} onChange={(e) => setEnrollF({ ...enrollF, username: e.target.value })} placeholder="SSH username" autoComplete="off" className={inputCls} />
                      <PasswordInput value={enrollF.password} onChange={(e) => setEnrollF({ ...enrollF, password: e.target.value })} placeholder="SSH password" autoComplete="off" className={inputCls} />
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => submitEnroll(m)} disabled={enroll.isPending} className="rounded-md bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{enroll.isPending ? 'Enrolling…' : 'Add agent'}</button>
                      <button onClick={() => setEnrollId(null)} className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted hover:text-white">Cancel</button>
                    </div>
                  </div>
                )}
                {enrollMsg?.id === m.id && (
                  <div className={`border-t border-border-soft px-4 py-1.5 text-2xs ${enrollMsg.ok ? 'text-success' : 'text-danger'}`}>{enrollMsg.text}</div>
                )}
                {detailId === m.id && <MonitorTelemetry m={m} chart={effChart} agent={agent} />}
              </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );

  if (embedded) return <div className="flex h-full flex-col">{body}</div>;
  return <Card title={title} bodyClassName="p-0">{body}</Card>;
}

/** Compact CPU/Mem/Disk pills shown on a monitor row when an agent is matched. */
function AgentMini({ a }: { a: AgentInfo }) {
  const cells: [string, number | null][] = [['C', a.cpuPct], ['M', a.memPct], ['D', a.diskPct]];
  return (
    <span className="hidden items-center gap-1 md:flex" title={`Agent ${a.name}${a.online ? '' : ' (offline)'} — CPU/Mem/Disk`}>
      {cells.map(([k, v]) => (
        <span key={k} className="flex items-center gap-0.5">
          <span className="text-[9px] text-muted">{k}</span>
          <span className="w-7 text-right text-2xs font-medium tabular-nums" style={{ color: v == null ? '#64748b' : metricColor(v) }}>{v == null ? '—' : `${Math.round(v)}%`}</span>
        </span>
      ))}
    </span>
  );
}

/** A labeled utilization bar (CPU / Memory / Disk) for the expanded system view. */
// Donut gauge (Power BI style) for a current metric value.
function Gauge({ label, value, max = 100, unit = '%' }: { label: string; value: number | null; max?: number; unit?: string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const c = value == null ? '#64748b' : metricColor(pct);
  const r = 26, circ = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 64 64" className="h-16 w-16">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#ffffff14" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={c} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(pct / 100) * circ} ${circ}`} transform="rotate(-90 32 32)" />
        <text x="32" y="34" textAnchor="middle" className="fill-white" style={{ fontSize: '13px', fontWeight: 600 }}>{value == null ? '—' : `${Math.round(value)}${unit}`}</text>
      </svg>
      <span className="text-2xs text-muted">{label}</span>
    </div>
  );
}

function SysBar({ label, value }: { label: string; value: number | null }) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const c = v == null ? '#64748b' : metricColor(v);
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 text-2xs text-muted">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full transition-all" style={{ width: `${v ?? 0}%`, background: c }} /></div>
      <span className="w-10 text-right text-2xs font-medium tabular-nums" style={{ color: c }}>{v == null ? '—' : `${Math.round(v)}%`}</span>
    </div>
  );
}

/** Expandable telemetry: agent system metrics + latency time-series, with selectable chart type. */
function MonitorTelemetry({ m, chart = 'line', agent }: { m: MonitorItem; chart?: string; agent?: AgentInfo }) {
  const hist = (m.history ?? []).slice(-30);
  const msVals = hist.map((h) => h.ms).filter((x): x is number => typeof x === 'number');
  const uptime = hist.length ? Math.round((hist.filter((h) => h.up).length / hist.length) * 100) : null;
  const avg = msVals.length ? Math.round(msVals.reduce((a, b) => a + b, 0) / msVals.length) : null;
  const min = msVals.length ? Math.min(...msVals) : null;
  const max = msVals.length ? Math.max(...msVals) : null;

  const W = 520, H = 64, pad = 4;
  const top = Math.max(max ?? 1, 1);
  const pts = hist.map((h, i) => {
    const x = pad + (i / Math.max(hist.length - 1, 1)) * (W - 2 * pad);
    const y = h.up && typeof h.ms === 'number' ? H - pad - (h.ms / top) * (H - 2 * pad) : H - pad;
    return { x, y, up: h.up, ms: h.ms };
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return (
    <div className="border-t border-border-soft bg-bg/30 px-4 py-3">
      {/* System metrics from a deployed agent (CPU / memory / disk), if one matches this host */}
      {agent ? (
        <div className="mb-3 rounded-lg border border-border bg-card/50 p-2.5">
          <div className="mb-2 flex items-center justify-between text-2xs">
            <span className="flex items-center gap-1.5 font-semibold text-white">🖥 System · {agent.name}
              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${agent.online ? 'bg-success/15 text-success' : 'bg-muted/20 text-muted'}`}>{agent.online ? 'online' : 'offline'}</span>
            </span>
            <span className="text-muted">{agent.lastSeenAt ? `seen ${timeAgo(agent.lastSeenAt)}` : 'never'} · {agent.mode}</span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-3">
            <SysBar label="CPU" value={agent.cpuPct} />
            <SysBar label="Memory" value={agent.memPct} />
            <SysBar label="Disk" value={agent.diskPct} />
          </div>
          <div className="mt-1.5 flex items-center gap-3 text-2xs text-muted">
            {agent.netMbps != null && <span>Net <span className="text-white">{agent.netMbps.toFixed(1)} Mbps</span></span>}
            {Array.isArray(agent.services) && agent.services.length > 0 && <span>{agent.services.length} services</span>}
            {agent.ips.length > 0 && <span className="truncate font-mono">{agent.ips.join(', ')}</span>}
          </div>
        </div>
      ) : (
        <div className="mb-3 rounded-lg border border-dashed border-border bg-card/30 px-3 py-2 text-2xs text-muted">
          No agent on this host — deploy the MCMF agent to capture <b className="text-white">CPU / memory / disk</b>. See <b className="text-white">Help → Guest Agent</b>.
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-3">
        <Stat label="Last" value={m.lastLatencyMs != null ? `${m.lastLatencyMs} ms` : '—'} />
        <Stat label="Avg" value={avg != null ? `${avg} ms` : '—'} />
        <Stat label="Min" value={min != null ? `${min} ms` : '—'} />
        <Stat label="Max" value={max != null ? `${max} ms` : '—'} />
        <Stat label="Jitter" value={m.jitterMs != null ? `${m.jitterMs} ms` : '—'} />
        <Stat label="Uptime" value={uptime != null ? `${uptime}%` : '—'} />
        {m.uptimeSec != null && <Stat label="Device up" value={fmtUptime(m.uptimeSec)} />}
        <span className="ml-auto text-2xs text-muted">{m.lastCheckedAt ? `checked ${timeAgo(m.lastCheckedAt)}` : 'never checked'}</span>
      </div>

      {chart === 'gauge' || chart === 'resbars' ? (
        !agent ? (
          <div className="py-4 text-center text-2xs text-muted">Resource charts need a deployed agent on this host (CPU / memory / disk).</div>
        ) : chart === 'gauge' ? (
          <div className="flex flex-wrap items-center justify-around gap-3 py-1">
            <Gauge label="CPU" value={agent.cpuPct} />
            <Gauge label="Memory" value={agent.memPct} />
            <Gauge label="Disk" value={agent.diskPct} />
            {agent.netMbps != null && <Gauge label="Net Mbps" value={agent.netMbps} max={1000} unit="" />}
          </div>
        ) : (
          <div className="flex h-24 items-end justify-around gap-4 px-4">
            {([['CPU', agent.cpuPct], ['Mem', agent.memPct], ['Disk', agent.diskPct]] as [string, number | null][]).map(([l, v]) => (
              <div key={l} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-2xs text-white">{v != null ? `${Math.round(v)}%` : '—'}</span>
                <div className="flex h-16 w-full max-w-[40px] items-end rounded bg-border/30"><div className="w-full rounded" style={{ height: `${Math.min(v ?? 0, 100)}%`, background: (v ?? 0) > 85 ? '#ef4444' : (v ?? 0) > 65 ? '#f59e0b' : '#22c55e' }} /></div>
                <span className="text-2xs text-muted">{l}</span>
              </div>
            ))}
          </div>
        )
      ) : hist.length === 0 ? (
        <div className="py-4 text-center text-2xs text-muted">No telemetry captured yet — first check runs within ~30s.</div>
      ) : chart === 'availability' ? (
        <div className="flex h-16 items-end gap-px">
          {hist.map((h, i) => (
            <span key={i} title={`${h.up ? 'up' : 'down'} · ${h.ms ?? '-'} ms`} className="flex-1 rounded-sm" style={{ height: h.up ? '100%' : '30%', background: h.up ? '#22c55e' : '#ef4444', opacity: 0.85 }} />
          ))}
        </div>
      ) : chart === 'bars' ? (
        <div className="flex h-16 items-end gap-px">
          {pts.map((p, i) => (
            <span key={i} title={`${p.up ? 'up' : 'down'} · ${p.ms ?? '-'} ms`} className="flex-1 rounded-sm" style={{ height: `${p.up && typeof p.ms === 'number' ? Math.max((p.ms / top) * 100, 4) : 100}%`, background: p.up ? '#22c55e' : '#ef4444', opacity: 0.85 }} />
          ))}
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" preserveAspectRatio="none">
          {chart === 'area' && <path d={`${line} L${pts[pts.length - 1].x.toFixed(1)},${H - pad} L${pts[0].x.toFixed(1)},${H - pad} Z`} fill="#22c55e22" />}
          <path d={line} fill="none" stroke="#22c55e" strokeWidth="1.5" />
          {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={1.6} fill={p.up ? '#22c55e' : '#ef4444'} />)}
        </svg>
      )}

      {(m.snmpCommunity || (m.interfaces && m.interfaces.length > 0) || (m.neighbors && m.neighbors.length > 0)) && <DeviceTelemetry m={m} />}
    </div>
  );
}

/** Network-device (firewall/router/switch) SNMP telemetry: per-interface bandwidth + LAN MAC table. */
function DeviceTelemetry({ m }: { m: MonitorItem }) {
  const ifaces = m.interfaces ?? [];
  const neighbors = m.neighbors ?? [];
  if (ifaces.length === 0 && neighbors.length === 0) {
    return <div className="mt-3 rounded-lg border border-dashed border-border bg-card/30 px-3 py-2 text-2xs text-muted">SNMP enabled — polling <span className="font-mono text-white">{bareHost(m.target)}:161</span>. Interfaces &amp; connected devices appear within ~30s. If nothing shows: verify the community string and that SNMP v2c is enabled on the device.</div>;
  }
  return (
    <div className="mt-3 space-y-3">
      {ifaces.length > 0 && (
        <div className="rounded-lg border border-border bg-card/50 p-2.5">
          <div className="mb-2 text-2xs font-semibold text-white">🔌 Interfaces · bandwidth ({ifaces.filter((i) => i.status === 'up').length}/{ifaces.length} up)</div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-2xs">
              <thead><tr className="text-left text-muted"><th className="py-1">Port</th><th>Status</th><th>Speed</th><th>In</th><th>Out</th><th className="w-28">Utilization</th></tr></thead>
              <tbody>
                {ifaces.map((i) => (
                  <tr key={i.index} className="border-t border-border-soft">
                    <td className="max-w-[140px] truncate py-1 font-mono text-white" title={i.name}>{i.name}</td>
                    <td><span style={{ color: i.status === 'up' ? '#22c55e' : '#ef4444' }}>● {i.status}</span></td>
                    <td className="text-muted-light">{i.speedMbps >= 1000 ? `${i.speedMbps / 1000}G` : i.speedMbps ? `${i.speedMbps}M` : '—'}</td>
                    <td className="text-muted-light">{fmtBps(i.inBps)}</td>
                    <td className="text-muted-light">{fmtBps(i.outBps)}</td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full" style={{ width: `${Math.min(100, i.utilPct)}%`, background: metricColor(i.utilPct) }} /></div>
                        <span className="w-9 text-right" style={{ color: metricColor(i.utilPct) }}>{i.utilPct}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {neighbors.length > 0 && (
        <div className="rounded-lg border border-border bg-card/50 p-2.5">
          <div className="mb-2 text-2xs font-semibold text-white">🖧 Connected devices on LAN ({neighbors.length}) · MAC ↔ IP ↔ port</div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-2xs">
              <thead><tr className="text-left text-muted"><th className="py-1">MAC address</th><th>IP</th><th>Via port</th></tr></thead>
              <tbody>
                {neighbors.map((n, idx) => (
                  <tr key={n.mac + idx} className="border-t border-border-soft">
                    <td className="py-1 font-mono text-white">{n.mac}</td>
                    <td className="font-mono text-muted-light">{n.ip ?? '—'}</td>
                    <td className="text-muted-light">{n.ifName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** seconds → "2d 4h" / "4h 12m" / "12m". */
function fmtUptime(sec: number): string {
  if (!sec || sec < 0) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), mn = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mn}m`;
  return `${mn}m`;
}

/** bits/sec → human-readable bandwidth. */
function fmtBps(bps: number): string {
  if (!bps || bps < 0) return '0';
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let v = bps, i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-2xs">
      <span className="text-muted">{label} </span>
      <span className="font-medium text-white">{value}</span>
    </span>
  );
}

function Uptime({ history }: { history?: { ts: string; up: boolean; ms: number | null }[] }) {
  const h = history ?? [];
  const uptime = h.length ? Math.round((h.filter((x) => x.up).length / h.length) * 100) : null;
  return (
    <div className="hidden items-center gap-1.5 sm:flex" title={uptime != null ? `${uptime}% uptime (last ${h.length})` : 'no history yet'}>
      <div className="flex h-4 items-end gap-px">
        {h.slice(-18).map((x, i) => (
          <span key={i} className="w-[3px] rounded-sm" style={{ height: x.up ? '100%' : '40%', background: x.up ? '#22c55e' : '#ef4444', opacity: 0.85 }} />
        ))}
        {h.length === 0 && <span className="text-2xs text-muted">—</span>}
      </div>
      {uptime != null && <span className="w-7 text-2xs text-muted">{uptime}%</span>}
    </div>
  );
}
