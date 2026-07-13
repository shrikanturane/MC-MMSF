'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Card, Modal } from '@/components/ui';
import { useResources } from '@/lib/hooks';
import {
  useReplicationSets, useCreateReplication, useDeleteReplication, useRunReplication, usePromoteReplication, useUpdateReplication, useEnrollAgent, useStopReplication, useTestReplication,
  useVpnLinks, useCreateVpn, useDeleteVpn, useVpnUp, useVpnDown, useVpnLinkStatus, useVpnGatewayTypes, useVpnRequirements, useVpnEligibleHosts, useVpnMonitor, useDiscoveredVpn, type DiscoveredVpn,
  useFabrics, useCreateFabric, useUpdateFabric, useArmFabric, useRetryFabric, useDeprovisionFabric, useDeleteFabric,
  type ReplicationSet, type ReplicationAgentInfo, type AgentEnroll, type ReplicationTest, type VpnLink, type VpnRequirements, type VpnEligibleHost, type NetworkFabric,
} from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { downloadText } from '@/lib/clipboard';

const STATE_LABEL: Record<string, { label: string; color: string }> = {
  'primary-active': { label: 'Primary active', color: '#22c55e' },
  'failed-over': { label: 'Failed over → secondary', color: '#f59e0b' },
  'tertiary-active': { label: 'Failed over → tertiary', color: '#a855f7' },
};
const STATUS_COLOR: Record<string, string> = { healthy: '#22c55e', running: '#3b82f6', failed: '#ef4444', idle: '#64748b', paused: '#64748b', lagging: '#f59e0b' };
const fmtLag = (s: number | null) => (s == null ? 'never' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

export function ReplicationView() {
  const sets = useReplicationSets();
  const create = useCreateReplication();
  const del = useDeleteReplication();
  const run = useRunReplication();
  const promote = usePromoteReplication();
  const update = useUpdateReplication();
  const stop = useStopReplication();
  const [showNew, setShowNew] = useState(false);
  const [edit, setEdit] = useState<ReplicationSet | null>(null);
  const [detail, setDetail] = useState<ReplicationSet | null>(null);
  const [testSet, setTestSet] = useState<ReplicationSet | null>(null);
  const [installHost, setInstallHost] = useState<string | null>(null);

  const list = sets.data ?? [];
  const kpis = useMemo(() => ({
    total: list.length,
    healthy: list.filter((s) => s.status === 'healthy').length,
    failed: list.filter((s) => s.status === 'failed').length,
    failedOver: list.filter((s) => s.state !== 'primary-active').length,
  }), [list]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">Replication &amp; DR Orchestration</div>
          <div className="text-2xs text-muted">Pair a primary VM with a secondary (and tertiary) in another cloud for application/database HA. MCMF orchestrates &amp; shows status; repoint DNS externally on failover.</div>
        </div>
        <button onClick={() => setShowNew(true)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ New replication set</button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Replication sets" value={kpis.total} color="#3b82f6" />
        <Kpi label="Healthy" value={kpis.healthy} color="#22c55e" />
        <Kpi label="Failed" value={kpis.failed} color="#ef4444" />
        <Kpi label="Failed over" value={kpis.failedOver} color="#f59e0b" />
      </div>

      {!list.length ? (
        <Card title="Replication sets" className="col-span-12">
          <div className="py-8 text-center text-2xs text-muted">No replication sets yet. Click <b className="text-white">+ New replication set</b> to pair two VMs across clouds for HA.</div>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((s) => {
            const st = STATE_LABEL[s.state] ?? STATE_LABEL['primary-active'];
            return (
              <div key={s.id} className="rounded-xl border border-border bg-card/60 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s.status] ?? '#64748b' }} />
                  <span className="text-sm font-semibold text-white">{s.name}</span>
                  <span className="rounded bg-bg px-1.5 py-0.5 text-2xs uppercase text-muted">{s.dataType}</span>
                  <span className="rounded bg-bg px-1.5 py-0.5 text-2xs text-muted-light">{s.mode}{s.mode === 'scheduled' ? ` · ${s.intervalMin}m` : ''}</span>
                  {s.driver === 'agent' && <AgentBadge agent={s.primaryAgent} role="primary" />}
                  {s.driver === 'agent' && <AgentBadge agent={s.secondaryAgent} role="secondary" />}
                  <span className="ml-auto rounded px-1.5 py-0.5 text-2xs font-medium" style={{ background: st.color + '22', color: st.color }}>{st.label}</span>
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-2xs">
                  {(() => {
                    // Order the nodes so the ACTIVE (live source) leads and the arrows flow OUT of it to
                    // the standby targets — so a failover visibly moves the live VM to the front and
                    // reverses the replication direction (e.g. Secondary → Primary after failing over).
                    const nodes = [
                      { label: 'Primary', name: s.primaryName, host: s.primaryHost, active: s.state === 'primary-active' },
                      { label: 'Secondary', name: s.secondaryName, host: s.secondaryHost, active: s.state === 'failed-over' },
                      ...(s.tertiaryHost ? [{ label: 'Tertiary', name: s.tertiaryName, host: s.tertiaryHost, active: s.state === 'tertiary-active' }] : []),
                    ];
                    const ordered = [...nodes].sort((a, b) => Number(b.active) - Number(a.active)); // active first (stable otherwise)
                    return ordered.map((n, i) => (
                      <Fragment key={n.label}>
                        {i > 0 && <span className={i === 1 && ordered[0].active ? 'text-success' : 'text-muted'}>→</span>}
                        <Node label={n.label} name={n.name} host={n.host} on={n.active} role={n.active ? 'source' : 'target'} />
                      </Fragment>
                    ));
                  })()}
                </div>
                <div className="mb-2 text-2xs text-muted">
                  {s.dataType === 'files'
                    ? <>Path: <span className="font-mono text-muted-light">{s.sourcePath || '—'}</span> → <span className="font-mono text-muted-light">{s.targetPath || s.sourcePath || '—'}</span> · </>
                    : s.dataType === 'docker'
                      ? <>Volumes: <span className="font-mono text-muted-light">{s.dockerVolumes || '—'}</span> · </>
                      : s.dataType === 'block'
                        ? <>DRBD: <span className="font-mono text-muted-light">{s.blockDevice || '—'} → /dev/drbd{s.drbdMinor}</span> <span className="text-success">RPO 0</span> · </>
                        : <>DB: <span className="font-mono text-muted-light">{s.dbEngine} / {s.dbName || '—'}</span> · </>}
                  Last sync: <span className="text-white">{fmtLag(s.lagSeconds)} ago</span>{s.lastRunAt ? ` (${timeAgo(s.lastRunAt)})` : ''}
                </div>
                {s.lastError && <div className="mb-2 break-words rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{s.lastError}</div>}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button onClick={() => run.mutate({ id: s.id })} disabled={s.status === 'running' || run.isPending} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{s.status === 'running' ? '◌ Syncing…' : 'Sync now'}</button>
                  {s.state === 'primary-active' ? (
                    <button onClick={() => { if (confirm(`Fail over "${s.name}" to the SECONDARY (${s.secondaryName})?\n\nThis marks the secondary as active. Then repoint your external DNS to ${s.secondaryHost}.`)) promote.mutate({ id: s.id, to: 'secondary' }); }} className="rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1 text-2xs font-medium text-warning hover:bg-warning/20">⚡ Fail over</button>
                  ) : (
                    <button onClick={() => { if (confirm(`Fail back "${s.name}" to the PRIMARY (${s.primaryName})? Repoint DNS to ${s.primaryHost}.`)) promote.mutate({ id: s.id, to: 'primary' }); }} className="rounded-md border border-success/50 bg-success/10 px-2.5 py-1 text-2xs font-medium text-success hover:bg-success/20">↩ Fail back</button>
                  )}
                  {s.tertiaryHost && s.state !== 'tertiary-active' && <button onClick={() => { if (confirm(`Fail over to the TERTIARY (${s.tertiaryName})? Repoint DNS to ${s.tertiaryHost}.`)) promote.mutate({ id: s.id, to: 'tertiary' }); }} className="rounded-md border border-purple/40 px-2.5 py-1 text-2xs font-medium" style={{ borderColor: '#a855f766', color: '#c084fc' }}>⚡ → Tertiary</button>}
                  <button onClick={() => setTestSet(s)} className="rounded-md border border-brand/40 bg-brand/10 px-2.5 py-1 text-2xs font-medium text-brand hover:bg-brand/20">✓ Test</button>
                  <button onClick={() => setEdit(s)} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">✎ Edit</button>
                  <button onClick={() => update.mutate({ id: s.id, enabled: !s.enabled })} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">{s.enabled ? 'Pause' : 'Resume'}</button>
                  {s.enabled && <button onClick={() => { if (confirm(`Stop replication "${s.name}"? Scheduling is disabled and any in-progress run is cleared. (Data on the hosts is not touched; Resume re-enables it.)`)) stop.mutate(s.id); }} className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1 text-2xs font-medium text-danger hover:bg-danger/20">■ Stop</button>}
                  {s.driver === 'agent' && <button onClick={() => setInstallHost(s.primaryHost)} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">⤓ Install agent</button>}
                  <button onClick={() => setDetail(s)} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">History</button>
                  <button onClick={() => { if (confirm(`Delete replication set "${s.name}"? (Data on the hosts is not touched.)`)) del.mutate(s.id); }} className="ml-auto rounded-md px-2 py-1 text-2xs text-danger hover:underline">Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <FabricPanel />
      <VpnPanel />

      {showNew && <SetModal mode="create" onClose={() => setShowNew(false)} onSave={(b) => create.mutateAsync(b).then(() => setShowNew(false))} busy={create.isPending} />}
      {edit && <SetModal mode="edit" initial={edit} onClose={() => setEdit(null)} onSave={(b) => update.mutateAsync({ id: edit.id, ...b }).then(() => setEdit(null))} busy={update.isPending} />}
      {testSet && <TestModal set={testSet} onClose={() => setTestSet(null)} />}
      {detail && <HistoryModal set={detail} onClose={() => setDetail(null)} />}
      {installHost && <AgentInstallModal host={installHost} onClose={() => setInstallHost(null)} />}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-2xs text-muted">{label}</div>
    </div>
  );
}

function AgentBadge({ agent, role }: { agent: ReplicationAgentInfo | null; role: 'primary' | 'secondary' }) {
  const online = !!agent?.online;
  const color = online ? '#22c55e' : '#f59e0b';
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium" style={{ background: color + '22', color }} title={agent ? `agent ${agent.host} · ${agent.os} v${agent.version} · last seen ${agent.lastSeenAt ? timeAgo(agent.lastSeenAt) : 'never'}` : `${role} agent not yet checked in`}>
      ⤓ {role[0].toUpperCase()} agent {online ? 'online' : agent ? 'offline' : 'pending'}
    </span>
  );
}

function TestModal({ set, onClose }: { set: ReplicationSet; onClose: () => void }) {
  const test = useTestReplication();
  const [res, setRes] = useState<ReplicationTest | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { test.mutateAsync(set.id).then(setRes).catch(() => setRes(null)); }, [set.id]);
  const ICON = { error: { s: '✗', c: '#ef4444' }, warn: { s: '▲', c: '#f59e0b' }, info: { s: '✓', c: '#22c55e' } } as const;
  return (
    <Modal wide title={`Connectivity test — ${set.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <button onClick={() => { setRes(null); test.mutateAsync(set.id).then(setRes).catch(() => setRes(null)); }} disabled={test.isPending} className="rounded-md bg-brand px-3 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{test.isPending ? '◌ Testing…' : '↻ Re-run test'}</button>
          <span className="text-2xs text-muted">Driver: <b className="text-white">{set.driver === 'agent' ? 'Installed agent' : 'MCMF (SSH)'}</b></span>
          {res && <span className="ml-auto rounded px-2 py-0.5 text-2xs font-medium" style={{ background: (res.ok ? '#22c55e' : '#ef4444') + '22', color: res.ok ? '#22c55e' : '#ef4444' }}>{res.ok ? '✓' : '✗'} {res.summary}</span>}
        </div>
        {!res ? <div className="py-6 text-center text-2xs text-muted">{test.isPending ? 'Running live diagnostics against each endpoint…' : 'No result.'}</div> : (
          <div className="space-y-1">
            {res.checks.map((c, i) => { const ic = c.ok ? ICON.info : ICON[c.level]; return (
              <div key={i} className="flex items-start gap-2 rounded border border-border bg-bg/40 px-2.5 py-1.5 text-2xs">
                <span style={{ color: ic.c }}>{ic.s}</span>
                <span className="min-w-[9rem] font-medium text-white">{c.name}</span>
                <span className="min-w-[7rem] font-mono text-muted">{c.target}</span>
                <span className="flex-1 text-muted-light">{c.detail}</span>
              </div>
            ); })}
          </div>
        )}
        <p className="text-2xs text-muted">Blocking issues (red) must be fixed before replication can run. Warnings (amber) are usually fine under the <b className="text-white">Installed agent</b> driver — e.g. MCMF can&apos;t reach a private/NAT&apos;d host directly, but the agent runs the job locally. Fix credentials in <b className="text-white">Credential Vault</b>, addresses/paths in <b className="text-white">✎ Edit</b>, and install the agent from the card.</p>
      </div>
    </Modal>
  );
}

function AgentInstallModal({ host, onClose }: { host: string; onClose: () => void }) {
  const enroll = useEnrollAgent();
  const [data, setData] = useState<AgentEnroll | null>(null);
  const [copied, setCopied] = useState('');
  const [os, setOs] = useState<'linux' | 'windows'>('linux');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { enroll.mutateAsync({ host }).then(setData).catch(() => undefined); }, [host]);
  const copy = (txt: string, which: string) => { navigator.clipboard?.writeText(txt).then(() => { setCopied(which); setTimeout(() => setCopied(''), 1500); }); };
  const inst = data ? (os === 'windows' ? data.windows : data.linux) : null;
  return (
    <Modal title={`Install replication agent on ${host}`} onClose={onClose}>
      <div className="space-y-3 text-xs text-muted-light">
        <p>Run this on <span className="font-mono text-white">{host}</span> (and on the secondary too, so it can replicate back after a failover). The agent runs as a background service that pulls its jobs from MCMF every 60s, runs them locally, and reports status here. It <b>auto-updates</b>, <b>survives reboot/logoff</b>, and <b>restarts on failure</b>. Outbound only — nothing inbound to open.</p>
        <div className="flex gap-1">
          {(['linux', 'windows'] as const).map((o) => (
            <button key={o} onClick={() => setOs(o)} className={`rounded-md px-3 py-1 text-2xs font-medium ${os === o ? 'bg-brand text-white' : 'border border-border bg-card text-muted-light hover:text-white'}`}>{o === 'linux' ? '🐧 Linux' : '🪟 Windows'}</button>
          ))}
          {data && <span className="ml-auto self-center text-2xs text-muted">agent v{data.version}</span>}
        </div>
        {!inst ? <div className="py-4 text-center text-muted">Generating enrollment…</div> : (
          <>
            <div>
              <div className="mb-1 flex items-center justify-between"><span className="text-2xs text-muted">{os === 'windows' ? 'Run in an elevated PowerShell (Admin)' : 'One-line install (run as root)'}</span><div className="flex gap-2"><button onClick={() => downloadText(os === 'windows' ? 'mcmf-repl-agent.ps1' : 'mcmf-repl-agent.sh', inst.script)} className="text-2xs text-brand hover:underline">⤓ download {os === 'windows' ? '.ps1' : '.sh'}</button><button onClick={() => copy(inst.oneLiner, 'one')} className="text-2xs text-brand hover:underline">{copied === 'one' ? 'copied ✓' : 'copy'}</button></div></div>
              <pre className="overflow-x-auto rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-2xs text-white">{inst.oneLiner}</pre>
            </div>
            <details className="rounded-lg border border-border bg-bg px-2.5 py-2">
              <summary className="cursor-pointer text-2xs text-muted">Show full agent script ({inst.script.length} bytes)</summary>
              <div className="mt-1 flex justify-end"><button onClick={() => copy(inst.script, 'scr')} className="text-2xs text-brand hover:underline">{copied === 'scr' ? 'copied ✓' : 'copy script'}</button></div>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre font-mono text-2xs text-muted-light">{inst.script}</pre>
            </details>
            <p className="text-2xs text-muted">Transport is <b>key-based SSH</b>: the agent generates a key and MCMF installs it on the target (using the target's Credential-Vault SSH creds) on first check-in — so add the target's SSH creds to the Vault first. {os === 'windows' ? 'Needs the built-in OpenSSH client (auto-enabled on install) + the DB client / Docker on PATH.' : 'Needs rsync + openssh-client (installed automatically) + the DB client / docker as applicable.'} The set must use <b>Run via: Installed agent</b>.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function Node({ label, name, host, on, role }: { label: string; name: string; host: string; on: boolean; role?: 'source' | 'target' }) {
  return (
    <span className={`inline-flex flex-col rounded-lg border px-2 py-1 ${on ? 'border-success/50 bg-success/10' : 'border-border bg-bg'}`}>
      <span className="flex items-center gap-1">
        <span className="text-2xs text-muted">{label}</span>
        {on ? <span className="text-2xs text-success">● live</span> : null}
        {role && <span className={`text-2xs ${role === 'source' ? 'text-success' : 'text-muted'}`}>· {role}</span>}
      </span>
      <span className="text-2xs text-white">{name || host || '—'}</span>
      <span className="font-mono text-2xs text-muted">{host}</span>
    </span>
  );
}

function SetModal({ mode, initial, onClose, onSave, busy }: { mode: 'create' | 'edit'; initial?: ReplicationSet; onClose: () => void; onSave: (b: Record<string, unknown>) => void; busy: boolean }) {
  const editing = mode === 'edit';
  const vms = useResources({ type: 'compute' });
  const [f, setF] = useState(() => ({
    name: initial?.name ?? '', dataType: initial?.dataType ?? 'files', mode: initial?.mode ?? 'scheduled', driver: initial?.driver ?? 'orchestrated',
    primaryId: initial?.primaryId ?? '', secondaryId: initial?.secondaryId ?? '', tertiaryId: initial?.tertiaryId ?? '',
    primaryHost: initial?.primaryHost ?? '', secondaryHost: initial?.secondaryHost ?? '', tertiaryHost: initial?.tertiaryHost ?? '',
    primaryOs: initial?.primaryOs ?? '', secondaryOs: initial?.secondaryOs ?? '', tertiaryOs: initial?.tertiaryOs ?? '',
    sourcePath: initial?.sourcePath ?? '', targetPath: initial?.targetPath ?? '', dbEngine: initial?.dbEngine ?? 'postgres', dbName: initial?.dbName ?? '', dbUser: initial?.dbUser ?? '', dbPassword: '',
    dockerVolumes: initial?.dockerVolumes ?? '', blockDevice: initial?.blockDevice ?? '', blockDeviceB: initial?.blockDeviceB ?? '', drbdPort: initial?.drbdPort ?? 7789, drbdMinor: initial?.drbdMinor ?? 0, drbdMount: initial?.drbdMount ?? '',
    intervalMin: initial?.intervalMin ?? 15, intervalSec: initial?.intervalSec || 30,
  }));
  const opts = (vms.data ?? []).map((r: any) => ({ id: r.id, label: `${r.name} (${r.provider})` }));
  const vmById = new Map((vms.data ?? []).map((r: any) => [r.id, r]));
  // Per-endpoint address picker: choose which IP to replicate over (Auto / Private / Public).
  const addr = (vmKey: keyof typeof f, hostKey: keyof typeof f) => {
    const r: any = vmById.get(f[vmKey] as string);
    if (!r || (!r.privateIp && !r.publicIp)) return null;
    return (
      <select value={f[hostKey] as string} onChange={(e) => setF({ ...f, [hostKey]: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-1 text-2xs text-muted-light focus:border-brand focus:outline-none" title="Which address to replicate over">
        <option value="">Address: Auto (cross-cloud → public)</option>
        {r.privateIp && <option value={r.privateIp}>Private · {r.privateIp}</option>}
        {r.publicIp && <option value={r.publicIp}>Public · {r.publicIp}</option>}
      </select>
    );
  };
  const sel = (label: string, key: keyof typeof f, allowNone = false) => (
    <label className="block"><span className="mb-1 block text-2xs text-muted">{label}</span>
      <select value={f[key] as string} onChange={(e) => setF({ ...f, [key]: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none">
        <option value="">{allowNone ? '— none —' : 'Select a VM…'}</option>
        {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
  // OS picker per endpoint — REQUIRED information for building the right sync command (Windows vs Linux).
  const osSel = (osKey: keyof typeof f) => (
    <select value={f[osKey] as string} onChange={(e) => setF({ ...f, [osKey]: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-1 text-2xs text-muted-light focus:border-brand focus:outline-none" title="Operating system of this endpoint">
      <option value="">OS: Auto (from provider)</option>
      <option value="linux">🐧 Linux</option>
      <option value="windows">🪟 Windows</option>
    </select>
  );
  // In edit mode the VM identity is fixed; expose an editable Host/IP field (+ OS) so the operator can
  // change the target address (public/private/custom) or OS without recreating the set.
  const endpoint = (role: 'primary' | 'secondary' | 'tertiary', label: string, allowNone = false) => {
    const idKey = `${role}Id` as keyof typeof f, hostKey = `${role}Host` as keyof typeof f, osKey = `${role}Os` as keyof typeof f;
    if (editing) {
      const nm = role === 'primary' ? initial?.primaryName : role === 'secondary' ? initial?.secondaryName : initial?.tertiaryName;
      return (
        <div>
          <span className="mb-1 block text-2xs text-muted">{label}{nm ? ` · ${nm}` : ''}</span>
          <input value={f[hostKey] as string} onChange={(e) => setF({ ...f, [hostKey]: e.target.value })} placeholder="host / IP (public or private)" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" />
          {osSel(osKey)}
        </div>
      );
    }
    return <div>{sel(label, idKey, allowNone)}{addr(idKey, hostKey)}{f[idKey] && osSel(osKey)}</div>;
  };
  const valid = !!f.name
    && (editing ? (!!f.primaryHost && !!f.secondaryHost) : (!!f.primaryId && !!f.secondaryId && f.primaryId !== f.secondaryId))
    && (f.dataType !== 'database' || !!f.dbName) && (f.dataType !== 'docker' || !!f.dockerVolumes) && (f.dataType !== 'block' || !!f.blockDevice);
  return (
    <Modal wide onClose={onClose} title={editing ? `Edit replication set — ${initial?.name}` : 'New replication set'}>
      <div className="space-y-3">
        <label className="block"><span className="mb-1 block text-2xs text-muted">Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. webapp-gcp-to-aws" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="mb-1 block text-2xs text-muted">Data type</span><select value={f.dataType} onChange={(e) => setF({ ...f, dataType: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none"><option value="files">Files / app data (rsync)</option><option value="database">Database (logical replication)</option><option value="docker">Docker volumes</option><option value="block">Block device — DRBD (synchronous, RPO 0)</option></select></label>
          <label className="block"><span className="mb-1 block text-2xs text-muted">Mode</span><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none"><option value="scheduled">Scheduled</option><option value="async">Asynchronous (near-real-time)</option><option value="sync">Synchronous</option></select></label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {endpoint('primary', 'Primary VM')}
          {endpoint('secondary', 'Secondary VM (other cloud)')}
          {endpoint('tertiary', 'Tertiary VM (optional)', true)}
        </div>
        {f.dataType === 'files' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="mb-1 block text-2xs text-muted">Source path (on primary)</span><input value={f.sourcePath} onChange={(e) => setF({ ...f, sourcePath: e.target.value })} placeholder="/var/www/app" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
            <label className="block"><span className="mb-1 block text-2xs text-muted">Target path (on secondary; blank = same)</span><input value={f.targetPath} onChange={(e) => setF({ ...f, targetPath: e.target.value })} placeholder="/var/www/app" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
          </div>
        )}
        {f.dataType === 'database' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="mb-1 block text-2xs text-muted">DB engine</span><select value={f.dbEngine} onChange={(e) => setF({ ...f, dbEngine: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none"><option value="postgres">PostgreSQL</option><option value="mysql">MySQL / MariaDB</option></select></label>
            <label className="block"><span className="mb-1 block text-2xs text-muted">Database name</span><input value={f.dbName} onChange={(e) => setF({ ...f, dbName: e.target.value })} placeholder="appdb" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
            <label className="block"><span className="mb-1 block text-2xs text-muted">DB user (blank = peer/socket auth)</span><input value={f.dbUser} onChange={(e) => setF({ ...f, dbUser: e.target.value })} placeholder="postgres" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
            <label className="block"><span className="mb-1 block text-2xs text-muted">DB password (encrypted; blank = peer auth)</span><input type="password" value={f.dbPassword} onChange={(e) => setF({ ...f, dbPassword: e.target.value })} placeholder="••••••" autoComplete="new-password" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
          </div>
        )}
        {f.dataType === 'docker' && (
          <label className="block"><span className="mb-1 block text-2xs text-muted">Docker named volumes (comma-separated)</span><input value={f.dockerVolumes} onChange={(e) => setF({ ...f, dockerVolumes: e.target.value })} placeholder="pgdata, appdata, uploads" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /><span className="mt-0.5 block text-2xs text-muted">Each volume's data is exported (via a throwaway container, no root path access needed), shipped to the secondary, and restored into the same-named volume. Needs <code>docker</code> on both hosts.</span></label>
        )}
        {f.dataType === 'block' && (
          <div className="space-y-3">
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-2xs text-warning">⚠ DRBD gives true synchronous, RPO-0 block replication (protocol C). The backing device must be a <b>dedicated, empty block device or LVM volume</b> on BOTH hosts — DRBD writes its metadata onto it (any existing filesystem there is lost). Linux-only.</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="mb-1 block text-2xs text-muted">Backing device on primary</span><input value={f.blockDevice} onChange={(e) => setF({ ...f, blockDevice: e.target.value })} placeholder="/dev/sdb" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
              <label className="block"><span className="mb-1 block text-2xs text-muted">Backing device on secondary (blank = same)</span><input value={f.blockDeviceB} onChange={(e) => setF({ ...f, blockDeviceB: e.target.value })} placeholder="/dev/sdb" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
              <label className="block"><span className="mb-1 block text-2xs text-muted">DRBD port</span><input type="number" value={f.drbdPort} onChange={(e) => setF({ ...f, drbdPort: Number(e.target.value) })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
              <label className="block"><span className="mb-1 block text-2xs text-muted">DRBD minor (/dev/drbdN)</span><input type="number" value={f.drbdMinor} onChange={(e) => setF({ ...f, drbdMinor: Number(e.target.value) })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
            </div>
            <span className="block text-2xs text-muted">MCMF installs <code>drbd-utils</code>, writes the resource, brings it up on both nodes, makes the primary Primary (seeds the initial full sync), and reports <code>drbdadm status</code>. Open TCP {f.drbdPort} between the hosts. On failover it promotes the secondary with <code>drbdadm primary</code>.</span>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <label className="block w-56"><span className="mb-1 block text-2xs text-muted">Run via</span><select value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none"><option value="orchestrated">MCMF (SSH from MCMF)</option><option value="agent">Installed agent (runs on the host)</option></select></label>
          {f.mode === 'scheduled' && <label className="block w-40"><span className="mb-1 block text-2xs text-muted">Interval (minutes)</span><input type="number" min={1} value={f.intervalMin} onChange={(e) => setF({ ...f, intervalMin: Number(e.target.value) })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>}
          {f.mode === 'sync' && f.dataType !== 'block' && <label className="block w-48"><span className="mb-1 block text-2xs text-muted">Near-sync interval (seconds)</span><input type="number" min={10} value={f.intervalSec} onChange={(e) => setF({ ...f, intervalSec: Number(e.target.value) })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>}
        </div>
        {f.mode === 'sync' && f.dataType !== 'block' && <div className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-2xs text-muted">Near-sync runs the {f.dataType} engine every {Math.max(10, f.intervalSec)}s — near-real-time, but not true synchronous (RPO is seconds, not zero). For RPO 0, use the <b className="text-white">Block device — DRBD</b> engine.</div>}
        {f.driver === 'agent'
          ? <div className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-2xs text-muted">The <b className="text-white">installed agent</b> on the primary pulls its jobs from MCMF and runs them locally (no inbound SSH from MCMF needed). After creating the set, click <b className="text-white">Install agent</b> on its card for the one-line installer. The agent still uses the target host's Credential-Vault SSH creds to push data.</div>
          : <div className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-2xs text-muted">Replication runs over SSH using the credentials in your <b className="text-white">Credential Vault</b> for each host (files need <code>rsync</code> + <code>sshpass</code> on the source). On failover, MCMF marks the new active side — you repoint DNS externally.</div>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button><button onClick={() => onSave(f)} disabled={!valid || busy} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{busy ? 'Saving…' : editing ? 'Save changes' : 'Create'}</button></div>
      </div>
    </Modal>
  );
}

const FABRIC_COLOR: Record<string, string> = { draft: '#64748b', provisioning: '#3b82f6', connecting: '#f59e0b', monitoring: '#3b82f6', up: '#22c55e', error: '#ef4444' };
const FABRIC_STAGES = ['net_a', 'net_b', 'gw_a', 'gw_b', 'conn', 'handoff', 'done'];

// Per-provider maturity of the fabric's API automation. Flip a provider to { label:'verified' } once its
// provision + teardown has been validated end-to-end on a live billing-enabled account.
const FABRIC_CAP: Record<string, { label: string; color: string; note: string }> = {
  aws: { label: 'experimental', color: '#f59e0b', note: 'AWS gateway/connection via EC2 SDK — unverified on a live account. Validate before production use.' },
  azure: { label: 'experimental', color: '#f59e0b', note: 'Azure gateway via ARM (VNet gateway ~30-45 min to create, ~10 min to delete) — unverified on a live account.' },
  gcp: { label: 'experimental', color: '#f59e0b', note: 'GCP Classic Cloud VPN via Compute REST — unverified on a live account. Validate before production use.' },
};
function FabricCapChip({ p }: { p: string }) {
  const c = FABRIC_CAP[p]; if (!c) return null;
  return <span className="rounded px-1 py-0.5 font-medium" style={{ background: c.color + '22', color: c.color, fontSize: '9px' }} title={c.note}>{c.label === 'verified' ? '✓ verified' : '⚗ ' + c.label}</span>;
}

function FabricPanel() {
  const fabrics = useFabrics();
  const create = useCreateFabric(); const upd = useUpdateFabric(); const arm = useArmFabric(); const retry = useRetryFabric(); const teardown = useDeprovisionFabric(); const del = useDeleteFabric();
  const [showNew, setShowNew] = useState(false);
  const [edit, setEdit] = useState<NetworkFabric | null>(null);
  const [detail, setDetail] = useState<NetworkFabric | null>(null);
  const list = fabrics.data ?? [];
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-white">🌐 Cross-cloud network fabric <span className="font-normal text-muted">(turnkey provisioning)</span></h3>
        <button onClick={() => setShowNew(true)} className="ml-auto rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-white hover:border-brand">+ New fabric</button>
      </div>
      <p className="mb-3 text-2xs text-muted">One governed pipeline provisions a network (VPC/VNet + subnet) and a site-to-site VPN gateway + connection in <b className="text-white">each of two clouds</b> via their APIs, wires them with a shared key, and hands the tunnel to the monitor above. Nothing is created until you <b className="text-white">Arm</b> it. <span className="text-warning">Experimental — the cloud gateway calls need validation on live billing-enabled accounts; Azure&apos;s gateway alone takes ~30–45 min.</span></p>
      {!list.length ? (
        <div className="rounded-xl border border-dashed border-border py-6 text-center text-2xs text-muted">No fabrics yet. Create one to provision a cross-cloud network + VPN end to end.</div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((f) => {
            const idx = FABRIC_STAGES.indexOf(f.stage);
            return (
              <div key={f.id} className="rounded-xl border border-border bg-card/60 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: FABRIC_COLOR[f.status] ?? '#64748b' }} />
                  <span className="text-sm font-semibold text-white">{f.name}</span>
                  <span className="rounded px-1.5 py-0.5 text-2xs font-medium" style={{ background: (FABRIC_COLOR[f.status] ?? '#64748b') + '22', color: FABRIC_COLOR[f.status] ?? '#64748b' }}>{f.status}</span>
                  {f.armed && f.status !== 'up' && <span className="text-2xs text-muted">stage {Math.max(0, idx) + 1}/{FABRIC_STAGES.length} · {f.stage}</span>}
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-2xs">
                  <span className="inline-flex flex-col gap-0.5 rounded-lg border border-border bg-bg px-2 py-1"><span className="flex items-center gap-1"><ProvChip p={f.aProvider} /><FabricCapChip p={f.aProvider} /><span className="text-muted">{f.aRegion || '—'}</span></span><span className="font-mono text-muted-light">{f.aCidr}</span><span className="font-mono text-white">{f.aGatewayIp || '(no gw ip yet)'}</span></span>
                  <span className="text-muted">🔒↔</span>
                  <span className="inline-flex flex-col gap-0.5 rounded-lg border border-border bg-bg px-2 py-1"><span className="flex items-center gap-1"><ProvChip p={f.bProvider} /><FabricCapChip p={f.bProvider} /><span className="text-muted">{f.bRegion || '—'}</span></span><span className="font-mono text-muted-light">{f.bCidr}</span><span className="font-mono text-white">{f.bGatewayIp || '(no gw ip yet)'}</span></span>
                </div>
                {f.lastError && <div className="mb-2 break-words rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{f.lastError}</div>}
                <div className="flex flex-wrap items-center gap-1.5">
                  {!f.armed
                    ? <button onClick={() => { if (confirm(`Arm "${f.name}"? This begins creating BILLABLE resources (networks, VPN gateways, connections) in ${f.aProvider.toUpperCase()} and ${f.bProvider.toUpperCase()}.`)) arm.mutate(f.id); }} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">▶ Arm &amp; provision</button>
                    : f.status === 'error'
                      ? <button onClick={() => retry.mutate(f.id)} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">↻ Retry</button>
                      : f.status === 'up'
                        ? <span className="rounded-md border border-success/40 px-2.5 py-1 text-2xs text-success">✓ provisioned · monitored above</span>
                        : <span className="rounded-md border border-border px-2.5 py-1 text-2xs text-muted-light">◌ running…</span>}
                  {(f.aGatewayId || f.bGatewayId || f.aConnId || f.bConnId || f.vpnLinkId) && <button onClick={() => { if (confirm(`Tear down the cloud VPN resources for "${f.name}"?\n\nThis deletes the VPN gateways + connections in ${f.aProvider.toUpperCase()} and ${f.bProvider.toUpperCase()} (the billable parts). Networks/VNets are left in place. Azure gateway deletion takes ~10 min.`)) teardown.mutate(f.id); }} disabled={teardown.isPending} className="rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1 text-2xs font-medium text-warning hover:bg-warning/20 disabled:opacity-50">{teardown.isPending ? '◌ Tearing down…' : '⤓ Tear down'}</button>}
                  {(!f.armed || f.status === 'error') && <button onClick={() => setEdit(f)} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">✎ Edit</button>}
                  {f.steps?.length ? <button onClick={() => setDetail(f)} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">Progress</button> : null}
                  <button onClick={() => { if (confirm(`Delete fabric record "${f.name}"? (Cloud resources already created are NOT deleted — remove them via ⤓ Tear down first, or in each cloud console.)`)) del.mutate(f.id); }} className="ml-auto rounded-md px-2 py-1 text-2xs text-danger hover:underline">Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showNew && <NewFabricModal onClose={() => setShowNew(false)} onSave={(b) => create.mutateAsync(b).then(() => setShowNew(false)).catch(() => undefined)} busy={create.isPending} />}
      {edit && <NewFabricModal initial={edit} onClose={() => setEdit(null)} onSave={(b) => upd.mutateAsync({ id: edit.id, ...b }).then(() => setEdit(null))} busy={upd.isPending} />}
      {detail && (
        <Modal wide title={`Fabric progress — ${detail.name}`} onClose={() => setDetail(null)}>
          <div className="max-h-[60vh] space-y-1 overflow-auto">
            {detail.steps.map((s, i) => (
              <div key={i} className="flex items-start gap-2 rounded border border-border bg-bg/40 px-2 py-1 text-2xs">
                <span className={s.status === 'ok' ? 'text-success' : s.status === 'error' ? 'text-danger' : 'text-warning'}>{s.status === 'ok' ? '✓' : s.status === 'error' ? '✗' : '◌'}</span>
                <span className="text-muted">{s.stage}</span>
                <span className="text-muted-light">{s.detail}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function NewFabricModal({ initial, onClose, onSave, busy }: { initial?: NetworkFabric; onClose: () => void; onSave: (b: Record<string, unknown>) => Promise<unknown> | void; busy: boolean }) {
  const editing = !!initial;
  const [err, setErr] = useState('');
  const [f, setF] = useState({
    name: initial?.name ?? '', psk: '',
    aProvider: initial?.aProvider ?? 'aws', aRegion: initial?.aRegion ?? 'us-east-1', aCidr: initial?.aCidr ?? '10.10.0.0/16', aSubnetCidr: initial?.aSubnetCidr ?? '10.10.0.0/24',
    bProvider: initial?.bProvider ?? 'azure', bRegion: initial?.bRegion ?? 'eastus', bCidr: initial?.bCidr ?? '10.20.0.0/16', bSubnetCidr: initial?.bSubnetCidr ?? '10.20.0.0/24',
  });
  const submit = () => { setErr(''); const r = onSave(f); if (r && typeof (r as any).catch === 'function') (r as Promise<unknown>).catch((e: any) => setErr(String(e?.message || e))); };
  const side = (s: 'a' | 'b') => (
    <div className="rounded-lg border border-border bg-bg/30 p-2.5 space-y-2">
      <div className="flex items-center gap-2 text-2xs font-semibold uppercase text-muted">Side {s.toUpperCase()} <FabricCapChip p={s === 'a' ? f.aProvider : f.bProvider} /></div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-2xs text-muted">Cloud</span><select value={s === 'a' ? f.aProvider : f.bProvider} onChange={(e) => setF({ ...f, [s === 'a' ? 'aProvider' : 'bProvider']: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none">{[['aws', 'AWS'], ['azure', 'Azure'], ['gcp', 'GCP']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="block"><span className="mb-1 block text-2xs text-muted">Region</span><input value={s === 'a' ? f.aRegion : f.bRegion} onChange={(e) => setF({ ...f, [s === 'a' ? 'aRegion' : 'bRegion']: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
        <label className="block"><span className="mb-1 block text-2xs text-muted">Network CIDR</span><input value={s === 'a' ? f.aCidr : f.bCidr} onChange={(e) => setF({ ...f, [s === 'a' ? 'aCidr' : 'bCidr']: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
        <label className="block"><span className="mb-1 block text-2xs text-muted">Subnet CIDR</span><input value={s === 'a' ? f.aSubnetCidr : f.bSubnetCidr} onChange={(e) => setF({ ...f, [s === 'a' ? 'aSubnetCidr' : 'bSubnetCidr']: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
      </div>
    </div>
  );
  // Region-format sanity — mirrors the server. Azure locations have NO dashes (eastus); AWS/GCP do
  // (us-east-1 / us-central1). Catches the #1 foot-gun: switching the cloud but leaving the default region.
  const regionErr = (provider: string, region: string): string | null => {
    const r = (region || '').trim();
    if (!r) return 'region required';
    if (provider === 'azure') return r.includes('-') || !/^[a-z][a-z0-9]+$/.test(r) ? 'Azure location has no dashes (e.g. eastus) — looks like another cloud’s region' : null;
    if (provider === 'aws') return /^[a-z]{2}-[a-z]+-\d+$/.test(r) ? null : 'AWS region looks like us-east-1 — looks like another cloud’s region';
    if (provider === 'gcp') return /^[a-z]+-[a-z]+\d+$/.test(r) ? null : 'GCP region looks like us-central1';
    return null;
  };
  const aRegErr = regionErr(f.aProvider, f.aRegion), bRegErr = regionErr(f.bProvider, f.bRegion);
  const valid = f.name && f.aProvider !== f.bProvider && f.aCidr && f.bCidr && !aRegErr && !bRegErr;
  return (
    <Modal wide title={editing ? `Edit fabric — ${initial?.name}` : 'New cross-cloud network fabric'} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="mb-1 block text-2xs text-muted">Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="aws-azure-fabric" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
          <label className="block"><span className="mb-1 block text-2xs text-muted">Pre-shared key (blank = auto)</span><input value={f.psk} onChange={(e) => setF({ ...f, psk: e.target.value })} placeholder="auto" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">{side('a')}{side('b')}</div>
        {f.aProvider === f.bProvider && <div className="text-2xs text-danger">Pick two different clouds.</div>}
        {aRegErr && <div className="text-2xs text-danger">Side A ({f.aProvider.toUpperCase()}): {aRegErr}.</div>}
        {bRegErr && <div className="text-2xs text-danger">Side B ({f.bProvider.toUpperCase()}): {bRegErr}.</div>}
        {err && <div className="break-words rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{err}</div>}
        <div className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-2xs text-muted">{editing ? <>Editing is allowed while the fabric is a <b className="text-white">draft</b> or has <b className="text-white">errored</b> (an errored fabric resets to draft so you can re-Arm). Tear down first to edit a live one.</> : <>Creates as a <b className="text-white">draft</b>. Provisioning starts only when you <b className="text-white">Arm</b> it on the card.</>} Requires both clouds connected under Cloud Connections. MCMF provisions the network + gateway + connection on each side via provider APIs, then registers the tunnel with the monitor above.</div>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button><button onClick={submit} disabled={!valid || busy} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{busy ? 'Saving…' : editing ? 'Save changes' : 'Create draft'}</button></div>
      </div>
    </Modal>
  );
}

const VPN_COLOR: Record<string, string> = { up: '#22c55e', down: '#64748b', error: '#ef4444', idle: '#64748b' };

const KIND_LABEL: Record<string, string> = { vpn: 'Site-to-site VPN', expressroute: 'ExpressRoute', interconnect: 'Interconnect', directconnect: 'Direct Connect' };
// Read-only inventory of EXISTING cross-cloud connectivity found in the connected clouds (pre-existing or
// set up outside MCMF) — so an operator sees what's already wired up + its live status the moment they connect a cloud.
function DiscoveredVpnSection() {
  const q = useDiscoveredVpn();
  const res = q.data;
  if (!res || res.total === 0) {
    return (
      <div className="mb-3 rounded-lg border border-border bg-bg/40 px-3 py-2 text-2xs text-muted">
        🔎 <b className="text-white">Discovered</b> — MCMF scans every connected cloud for existing site-to-site VPNs, tunnels and cross-connects. {q.isLoading ? 'Scanning…' : 'None found in the connected clouds (or the connection lacks read permission).'}
      </div>
    );
  }
  const items = [...res.items].sort((a: DiscoveredVpn, b: DiscoveredVpn) => (a.provider + a.name).localeCompare(b.provider + b.name));
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center gap-2 text-2xs text-muted">
        <span>🔎 <b className="text-white">Discovered cross-cloud connectivity</b> — existing links found in your clouds (read-only)</span>
        <span className="rounded bg-bg px-1.5 py-0.5" style={{ color: '#22c55e' }}>{res.up} up</span>
        <span className="rounded bg-bg px-1.5 py-0.5 text-muted-light">{res.total} total</span>
        <button onClick={() => q.refetch()} disabled={q.isFetching} className="ml-auto rounded border border-border bg-card px-2 py-0.5 text-muted-light hover:text-white disabled:opacity-50">{q.isFetching ? '◌' : '↻'} Rescan</button>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {items.map((it) => (
          <div key={it.provider + it.id} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card/40 px-2.5 py-1.5 text-2xs">
            <span className="h-2 w-2 rounded-full" style={{ background: VPN_COLOR[it.status] ?? '#64748b' }} />
            <ProvChip p={it.provider} />
            <span className="font-medium text-white">{it.name}</span>
            <span className="rounded bg-bg px-1 py-0.5 text-muted">{KIND_LABEL[it.kind] ?? it.kind}</span>
            {it.managed && <span className="rounded px-1 py-0.5 text-brand" style={{ background: '#3b82f622' }}>MCMF</span>}
            {it.region && <span className="text-muted">{it.region}</span>}
            <span className="ml-auto rounded px-1.5 py-0.5 font-medium" style={{ background: (VPN_COLOR[it.status] ?? '#64748b') + '22', color: VPN_COLOR[it.status] ?? '#64748b' }}>{it.status === 'up' ? '● connected' : it.status}</span>
            {(it.remoteAddr || it.remoteSubnets || it.detail) && (
              <div className="w-full text-muted">{it.remoteAddr ? <>peer <span className="font-mono text-muted-light">{it.remoteAddr}</span> · </> : null}{it.remoteSubnets ? <>routes <span className="font-mono text-muted-light">{it.remoteSubnets}</span> · </> : null}{it.detail}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function VpnPanel() {
  const links = useVpnLinks();
  const up = useVpnUp(); const down = useVpnDown(); const stat = useVpnLinkStatus(); const del = useDeleteVpn(); const mon = useVpnMonitor();
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState<VpnLink | null>(null);
  const list = links.data ?? [];
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-white">🔒 Cross-cloud VPN links <span className="font-normal text-muted">(IPsec / strongSwan)</span></h3>
        <button onClick={() => setShowNew(true)} className="ml-auto rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-white hover:border-brand">+ New VPN link</button>
      </div>
      <p className="mb-3 text-2xs text-muted">A private, encrypted IPsec tunnel between two clouds/sites. Two ways: <b className="text-white">⚙ auto-config</b> (both ends are managed Linux VMs — MCMF installs strongSwan and builds the tunnel) or <b className="text-white">👁 monitor-only</b> (gateway↔gateway — AWS/Azure/GCP/on-prem VPN gateways you set up yourself; MCMF just watches the site-to-site status + which ports are open, via the cloud API or an active probe). Point a replication set at the peer&apos;s private subnet to use it.</p>
      <DiscoveredVpnSection />

      {!list.length ? (
        <div className="rounded-xl border border-dashed border-border py-6 text-center text-2xs text-muted">No VPN links yet. Create one to give replication a private encrypted path.</div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((l) => (
            <div key={l.id} className="rounded-xl border border-border bg-card/60 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: VPN_COLOR[l.status] ?? '#64748b' }} />
                <span className="text-sm font-semibold text-white">{l.name}</span>
                <span className="rounded bg-bg px-1.5 py-0.5 text-2xs uppercase text-muted">{l.tech}</span>
                <span className="rounded bg-bg px-1.5 py-0.5 text-2xs text-muted-light">{l.mode} · {l.ikeVersion}</span>
                <span className="rounded px-1.5 py-0.5 text-2xs font-medium" style={{ background: (l.manage === 'monitor' ? '#a855f7' : '#3b82f6') + '22', color: l.manage === 'monitor' ? '#c084fc' : '#60a5fa' }} title={l.manage === 'monitor' ? 'You set up the tunnel; MCMF only monitors it' : 'MCMF configures strongSwan on the VM endpoint(s)'}>{l.manage === 'monitor' ? '👁 monitor-only' : '⚙ auto-config'}</span>
                <span className="ml-auto rounded px-1.5 py-0.5 text-2xs font-medium" style={{ background: (VPN_COLOR[l.status] ?? '#64748b') + '22', color: VPN_COLOR[l.status] ?? '#64748b' }}>{l.status === 'up' ? '● connected' : l.status}{l.statusSource ? ` · ${l.statusSource}` : ''}</span>
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-1.5 text-2xs">
                <span className="inline-flex flex-col gap-0.5 rounded-lg border border-border bg-bg px-2 py-1"><span className="flex items-center gap-1"><span className="text-muted">{l.aName || 'Side A'}</span>{l.aProvider && <ProvChip p={l.aProvider} />}</span><span className="font-mono text-white">{l.aHost}</span><span className="font-mono text-muted">{l.aSubnet}</span></span>
                <span className="text-muted">🔒↔</span>
                <span className="inline-flex flex-col gap-0.5 rounded-lg border border-border bg-bg px-2 py-1"><span className="flex items-center gap-1"><span className="text-muted">{l.bManual ? (l.bDevice || 'External gateway') : (l.bName || 'Side B')}</span>{l.bProvider && <ProvChip p={l.bProvider} />}</span><span className="font-mono text-white">{l.bHost}</span><span className="font-mono text-muted">{l.bSubnet}</span></span>
              </div>
              {l.manage === 'monitor' && (l.monitorResult || l.monitorTarget) && (
                <div className="mb-2 rounded border border-border bg-bg/50 px-2 py-1 text-2xs"><span className="text-muted">Tunnel probe → </span><span className="font-mono text-muted-light">{l.monitorTarget || '(no target set)'}</span>{l.lastMonitorAt ? <span className="text-muted"> · {timeAgo(l.lastMonitorAt)}</span> : ''}{l.monitorResult && <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-muted-light">{l.monitorResult}</pre>}</div>
              )}
              {l.lastError && <div className="mb-2 break-words rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{l.lastError}</div>}
              <div className="flex flex-wrap items-center gap-1.5">
                {l.manage === 'monitor' ? (
                  <button onClick={() => mon.mutate(l.id)} disabled={mon.isPending} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{mon.isPending ? '◌ Checking…' : '✓ Check now'}</button>
                ) : (
                  <>
                    <button onClick={() => up.mutate(l.id)} disabled={up.isPending} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{up.isPending ? '◌ Bringing up…' : l.status === 'up' ? '↻ Re-establish' : '▲ Bring up'}</button>
                    <button onClick={() => stat.mutate(l.id)} disabled={stat.isPending} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white disabled:opacity-50">{stat.isPending ? '◌ Checking…' : '↻ Refresh status'}</button>
                    {l.status === 'up' && <button onClick={() => down.mutate(l.id)} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">▼ Down</button>}
                  </>
                )}
                {l.lastStatus && <button onClick={() => setDetail(l)} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">SA status</button>}
                <button onClick={() => { if (confirm(`Delete VPN link "${l.name}"?${l.manage === 'monitor' ? '' : ' (Tears the tunnel down on the hosts.)'}`)) del.mutate(l.id); }} className="ml-auto rounded-md px-2 py-1 text-2xs text-danger hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showNew && <NewVpnModal onClose={() => setShowNew(false)} />}
      {detail && (
        <Modal wide title={`IPsec SA status — ${detail.name}`} onClose={() => setDetail(null)}>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-2 font-mono text-2xs text-muted-light">{detail.lastStatus || 'No status yet.'}</pre>
        </Modal>
      )}
    </div>
  );
}

const PROV_CHIP: Record<string, { label: string; color: string }> = {
  aws: { label: 'AWS', color: '#ff9900' }, azure: { label: 'Azure', color: '#0089d6' }, gcp: { label: 'GCP', color: '#34a853' },
  private: { label: 'On-prem', color: '#94a3b8' }, onprem: { label: 'On-prem', color: '#94a3b8' }, docker: { label: 'Docker', color: '#2496ed' },
};
function ProvChip({ p }: { p: string }) { const c = PROV_CHIP[p] ?? { label: p || '—', color: '#64748b' }; return <span className="rounded px-1.5 py-0.5 text-2xs font-semibold" style={{ background: c.color + '22', color: c.color }}>{c.label}</span>; }

const VPN_PROVS: [string, string][] = [['aws', 'AWS'], ['azure', 'Azure'], ['gcp', 'GCP'], ['private', 'Private / DC'], ['onprem', 'On-prem']];

function NewVpnModal({ onClose }: { onClose: () => void }) {
  const eh = useVpnEligibleHosts();
  const gwTypes = useVpnGatewayTypes();
  const reqm = useVpnRequirements();
  const create = useCreateVpn();
  const [f, setF] = useState({
    name: '', mode: 'site-to-site', ikeVersion: 'ikev2',
    aManual: false, aId: '', aProvider: 'aws', aHost: '', aDevice: '',
    bManual: true, bId: '', bHost: '', bDevice: '', bProvider: 'aws', peerType: 'aws',
    aSubnet: '', bSubnet: '', psk: '',
    vpnConnId: '', monitorHost: '', monitorTarget: '', monitorPorts: '443,22',
  });
  const [req, setReq] = useState<VpnRequirements | null>(null);
  const [touched, setTouched] = useState({ aSubnet: false, bSubnet: false });
  const linuxHosts = (eh.data ?? []).filter((h) => h.os === 'linux'); // strongSwan endpoints must be Linux
  const allHosts = eh.data ?? []; // any SSH-cred host can be the monitor probe origin
  // MCMF configures via side A (the initiator). If side A is a gateway it can't configure anything -> monitor-only.
  const monitorOnly = f.aManual;
  const CLOUDS = ['aws', 'azure', 'gcp'];
  const cloudProvider = (f.aManual && CLOUDS.includes(f.aProvider) && f.aProvider)
    || (f.bManual && CLOUDS.includes(f.bProvider) && f.bProvider)
    || (req && CLOUDS.includes(req.aProvider) && req.aProvider)
    || (req && CLOUDS.includes(req.bProvider) && req.bProvider) || '';
  const CONN_HINT: Record<string, { label: string; ph: string }> = {
    aws: { label: 'AWS VPN connection id (authoritative status)', ph: 'vpn-0abc123...' },
    azure: { label: 'Azure connection — resourceGroup/name (authoritative status)', ph: 'rg-network/s2s-conn' },
    gcp: { label: 'GCP VPN tunnel — region/name (authoritative status)', ph: 'us-central1/my-tunnel' },
  };
  // Auto-populate providers/subnets/requirements as the endpoints change.
  useEffect(() => {
    const aReady = f.aManual ? !!f.aProvider : !!f.aId;
    const bReady = f.bManual ? !!f.bProvider : !!f.bId;
    if (!aReady || !bReady) { setReq(null); return; }
    let live = true;
    reqm.mutateAsync({ aManual: f.aManual, aId: f.aId, aProvider: f.aProvider, bManual: f.bManual, bId: f.bId, bProvider: f.bProvider, peerType: f.peerType, bHost: f.bHost }).then((r) => {
      if (!live) return;
      setReq(r);
      setF((prev) => ({ ...prev,
        aSubnet: touched.aSubnet ? prev.aSubnet : (prev.aSubnet || r.aSubnet),
        bSubnet: touched.bSubnet ? prev.bSubnet : (prev.bSubnet || r.bSubnet) }));
    }).catch(() => setReq(null));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.aManual, f.aId, f.aProvider, f.bManual, f.bId, f.bProvider, f.peerType]);
  const gwProviderSel = (side: 'a' | 'b') => (
    <label className="block"><span className="mb-1 block text-2xs text-muted">Cloud / gateway</span>
      <select value={side === 'a' ? f.aProvider : f.bProvider} onChange={(e) => setF({ ...f, [side === 'a' ? 'aProvider' : 'bProvider']: e.target.value, ...(side === 'b' ? { peerType: e.target.value } : {}) })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none">{VPN_PROVS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
  );
  const vmSel = (side: 'a' | 'b') => (
    <label className="block"><span className="mb-1 block text-2xs text-muted">{side === 'a' ? 'Side A' : 'Side B'} VM (running Linux, has SSH cred)</span>
      <select value={side === 'a' ? f.aId : f.bId} onChange={(e) => setF({ ...f, [side === 'a' ? 'aId' : 'bId']: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none">
        <option value="">{linuxHosts.length ? '— pick a VM —' : '— no eligible VM (needs SSH cred in Vault) —'}</option>
        {linuxHosts.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.provider} · {h.host}</option>)}
      </select></label>
  );
  const endpoint = (side: 'a' | 'b') => {
    const manual = side === 'a' ? f.aManual : f.bManual;
    return (
      <div className="rounded-lg border border-border bg-bg/30 p-2.5">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-2xs font-semibold uppercase text-muted">Side {side.toUpperCase()}</span>
          <label className="flex items-center gap-1 text-2xs text-muted-light"><input type="radio" checked={!manual} onChange={() => setF({ ...f, [side === 'a' ? 'aManual' : 'bManual']: false })} /> Managed VM (MCMF configures)</label>
          <label className="flex items-center gap-1 text-2xs text-muted-light"><input type="radio" checked={manual} onChange={() => setF({ ...f, [side === 'a' ? 'aManual' : 'bManual']: true })} /> Gateway (you configure, MCMF monitors)</label>
        </div>
        {!manual ? (
          <div>{vmSel(side)}{req && (side === 'a' ? req.aProvider : req.bProvider) && <div className="mt-1 flex items-center gap-1 text-2xs text-muted">detected: <ProvChip p={side === 'a' ? req.aProvider : req.bProvider} /></div>}</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {gwProviderSel(side)}
            <label className="block"><span className="mb-1 block text-2xs text-muted">Gateway public IP</span><input value={side === 'a' ? f.aHost : f.bHost} onChange={(e) => setF({ ...f, [side === 'a' ? 'aHost' : 'bHost']: e.target.value })} placeholder="203.0.113.10" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
            {side === 'b' && <label className="block sm:col-span-2"><span className="mb-1 block text-2xs text-muted">Gateway type (for the setup checklist)</span><select value={f.peerType} onChange={(e) => setF({ ...f, peerType: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none">{(gwTypes.data ?? []).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}</select></label>}
            <label className="block sm:col-span-2"><span className="mb-1 block text-2xs text-muted">Label (optional)</span><input value={side === 'a' ? f.aDevice : f.bDevice} onChange={(e) => setF({ ...f, [side === 'a' ? 'aDevice' : 'bDevice']: e.target.value })} placeholder={side === 'a' ? 'AWS us-east VGW' : 'HQ FortiGate 100F'} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
          </div>
        )}
      </div>
    );
  };
  const valid = !!f.name && (f.aManual ? !!f.aHost : !!f.aId) && (f.bManual ? !!f.bHost : !!f.bId) && (f.mode === 'host-to-host' || (!!f.aSubnet && !!f.bSubnet));
  return (
    <Modal wide title="New cross-cloud VPN link (IPsec)" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="mb-1 block text-2xs text-muted">Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="gcp-to-aws" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" /></label>
          <label className="block"><span className="mb-1 block text-2xs text-muted">Mode</span><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none"><option value="site-to-site">Site-to-site (route subnets)</option><option value="host-to-host">Host-to-host (just the two VMs)</option></select></label>
        </div>
        <div className={`rounded-lg border px-3 py-1.5 text-2xs ${monitorOnly ? 'border-purple-500/30 bg-purple-500/5 text-purple-200/90' : 'border-border bg-bg/40 text-muted'}`}>
          {monitorOnly
            ? <><b className="text-white">👁 Monitor-only.</b> Side A is a gateway, so you set up the tunnel in the cloud console / on the firewall; MCMF configures nothing and just watches the site-to-site status + which ports are open (via the cloud API where available, or an active probe from a host you name below). Use this for gateway↔gateway.</>
            : <><b className="text-white">⚙ Auto-config.</b> MCMF installs strongSwan on side A over SSH and brings the tunnel up{f.bManual ? '; side B is your external gateway, so MCMF shows the mirror config + PSK to apply there' : ' (and configures side B too when it is a managed VM)'}. Managed VMs must be running Linux with an SSH credential in the Vault.</>}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">{endpoint('a')}{endpoint('b')}</div>
        {f.mode === 'site-to-site' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="mb-1 block text-2xs text-muted">Side A subnet (CIDR){req?.aSubnet && f.aSubnet === req.aSubnet ? ' · auto' : ''}</span><input value={f.aSubnet} onChange={(e) => { setTouched({ ...touched, aSubnet: true }); setF({ ...f, aSubnet: e.target.value }); }} placeholder="10.10.0.0/24" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
            <label className="block"><span className="mb-1 block text-2xs text-muted">Side B subnet (CIDR){req?.bSubnet && f.bSubnet === req.bSubnet ? ' · auto' : ''}</span><input value={f.bSubnet} onChange={(e) => { setTouched({ ...touched, bSubnet: true }); setF({ ...f, bSubnet: e.target.value }); }} placeholder="10.20.0.0/24" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
          </div>
        )}
        {!monitorOnly && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="mb-1 block text-2xs text-muted">IKE version</span><select value={f.ikeVersion} onChange={(e) => setF({ ...f, ikeVersion: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none"><option value="ikev2">IKEv2</option><option value="ikev1">IKEv1</option></select></label>
            <label className="block"><span className="mb-1 block text-2xs text-muted">Pre-shared key (blank = auto-generate)</span><input value={f.psk} onChange={(e) => setF({ ...f, psk: e.target.value })} placeholder="auto" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
          </div>
        )}
        {monitorOnly && (
          <div className="space-y-2 rounded-lg border border-purple-500/30 bg-purple-500/5 p-2.5">
            <div className="text-2xs font-semibold text-white">Monitor settings — how MCMF reads the tunnel status</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block"><span className="mb-1 block text-2xs text-muted">Probe from (a VM with SSH cred, near one end)</span>
                <select value={f.monitorHost} onChange={(e) => setF({ ...f, monitorHost: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none">
                  <option value="">— none / auto —</option>{allHosts.map((h) => <option key={h.id} value={h.credHost}>{h.name} · {h.os} · {h.host}</option>)}
                </select></label>
              <label className="block"><span className="mb-1 block text-2xs text-muted">Target IP on the far side (reached through the tunnel)</span><input value={f.monitorTarget} onChange={(e) => setF({ ...f, monitorTarget: e.target.value })} placeholder="10.20.0.10" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
              <label className="block"><span className="mb-1 block text-2xs text-muted">Ports to test across the tunnel (TCP, comma-separated)</span><input value={f.monitorPorts} onChange={(e) => setF({ ...f, monitorPorts: e.target.value })} placeholder="443,22,3389" className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>
              {cloudProvider && <label className="block"><span className="mb-1 block text-2xs text-muted">{CONN_HINT[cloudProvider].label} <span className="text-muted-light">· optional</span></span><input value={f.vpnConnId} onChange={(e) => setF({ ...f, vpnConnId: e.target.value })} placeholder={CONN_HINT[cloudProvider].ph} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-white focus:border-brand focus:outline-none" /></label>}
            </div>
            <div className="text-2xs text-muted">If you give the cloud <b className="text-white">VPN connection/tunnel id</b> and MCMF has that {cloudProvider ? cloudProvider.toUpperCase() : 'cloud'} account connected, it reads the real tunnel state from the provider API (AWS DescribeVpnConnections · Azure connectionStatus · GCP vpnTunnel status). Otherwise it pings the target + TCP-tests the ports from the probe host to infer up/down and which ports are open.</div>
          </div>
        )}
        {req && <VpnReqPanel req={req} bManual={f.bManual || f.aManual} />}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button><button onClick={() => create.mutateAsync(f).then(onClose).catch(() => undefined)} disabled={!valid || create.isPending} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{create.isPending ? 'Creating…' : 'Create'}</button></div>
      </div>
    </Modal>
  );
}

function VpnReqPanel({ req, bManual }: { req: VpnRequirements; bManual: boolean }) {
  return (
    <div className="space-y-2 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-2xs">
      <div className="flex flex-wrap items-center gap-2 text-muted-light"><b className="text-white">Auto-detected requirements</b> · <ProvChip p={req.aProvider} /> <span className="text-muted">↔</span> {bManual ? <span className="text-white">{req.profileLabel}</span> : <ProvChip p={req.bProvider} />}</div>
      <div className="text-muted">Ports both ends must allow: <span className="text-white">{req.ports.join(' · ')}</span></div>
      <div className="text-muted">Negotiated crypto (vendor-compatible): <span className="font-mono text-muted-light">IKE {req.ike}</span> · <span className="font-mono text-muted-light">ESP {req.esp}</span></div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div><div className="mb-0.5 font-semibold text-white">On side A&apos;s cloud ({PROV_CHIP[req.aProvider]?.label ?? req.aProvider})</div><ul className="ml-3 list-disc space-y-0.5 text-muted-light">{req.aReqs.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
        <div><div className="mb-0.5 font-semibold text-white">On the {bManual ? 'remote gateway' : 'other cloud'} ({req.profileLabel})</div><ul className="ml-3 list-disc space-y-0.5 text-muted-light">{(bManual ? req.peerReqs : req.bReqs).map((r, i) => <li key={i}>{r}</li>)}</ul></div>
      </div>
      {bManual && <div className="text-muted">Mirror on the far gateway: <span className="text-muted-light">{req.mirror.join(' · ')}</span>. After you click Create then Bring up, the card&apos;s error/hint shows the exact PSK + mirror lines.</div>}
    </div>
  );
}

function HistoryModal({ set, onClose }: { set: ReplicationSet; onClose: () => void }) {
  return (
    <Modal wide onClose={onClose} title={`Run history — ${set.name}`}>
      {!set.runs.length ? <div className="py-6 text-center text-2xs text-muted">No runs yet. Click “Sync now”.</div> : (
        <div className="max-h-[60vh] space-y-2 overflow-auto">
          {set.runs.map((r) => (
            <div key={r.id} className="rounded-lg border border-border bg-bg/40 p-2 text-2xs">
              <div className="flex items-center gap-2"><span className={r.ok ? 'text-success' : 'text-danger'}>{r.ok ? '✓ ok' : '✗ failed'}</span><span className="text-muted">{r.direction}</span><span className="text-muted">{Math.round(r.durationMs / 100) / 10}s</span><span className="ml-auto text-muted">{timeAgo(r.startedAt)}</span></div>
              {r.detail && <div className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-muted-light">{r.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
