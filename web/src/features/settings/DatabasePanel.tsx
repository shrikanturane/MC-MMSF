'use client';

import { useState } from 'react';
import { Card, Modal } from '@/components/ui';
import { PasswordInput } from '@/components/PasswordInput';
import {
  useDbStatus, useDbBackups, useDbBackupNow, useFullSnapshot, useDownloadBackup, useSetBackupConfig, useFailoverGuide, useLogSearch,
  useCluster, useAddClusterNode, useRemoveClusterNode, useSetClusterCname, useNodeSetup,
  useDeployNode, useSetNodeCreds, useResyncNode, usePromoteExec,
  useSyncToProd, useSetNodeEnv, useSetEnvLabel, useSetNodeSyncPaused, useReleaseNotes,
} from '@/lib/hooks';
import type { DeployRecord } from '@/lib/hooks';
import type { ClusterNodeStatus } from '@/lib/hooks';
import { copyText, downloadText } from '@/lib/clipboard';
import { BackupPanel } from './BackupPanel';
import { timeAgo, number } from '@/lib/format';
import { useTabParam } from '@/lib/useTabParam';

/** Wall-clock time in the viewer's own timezone (e.g. Asia/Calcutta) — "🕐 11:06 PM" style. */
const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : '';

const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
};

/** Admin: database status, table/log growth, backups (+ on-demand), replication & retention. */
export function DatabasePanel() {
  const status = useDbStatus();
  const backups = useDbBackups();
  const backupNow = useDbBackupNow();
  const fullSnapshot = useFullSnapshot();
  const downloadBackup = useDownloadBackup();
  const setBackupCfg = useSetBackupConfig();
  const [extPath, setExtPath] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sub, setSub] = useTabParam<'status' | 'logs' | 'backups' | 'ha'>('db', 'status', ['status', 'logs', 'backups', 'ha']);
  const s = status.data;

  const runBackup = async () => {
    setMsg(null);
    try { const r = await backupNow.mutateAsync(); setMsg(`Backup created: ${r.name} (${fmtBytes(r.bytes)}).`); }
    catch (e) { setMsg((e as Error).message); }
  };
  const runFullSnapshot = async () => {
    setMsg(null);
    if (!confirm('Create a full system snapshot?\n\nBundles the app docker images + full source code + a fresh database dump into one restore-anywhere archive. This can be large (GBs) and take a few minutes.')) return;
    try { const r = await fullSnapshot.mutateAsync(); setMsg(`Full snapshot created: ${r.name} (${fmtBytes(r.bytes)}) — ${r.images} image(s) + ${r.source ? 'source + ' : ''}database.`); }
    catch (e) { setMsg((e as Error).message); }
  };

  const dot = (ok: boolean) => <span className="h-2 w-2 rounded-full" style={{ background: ok ? '#22c55e' : '#ef4444' }} />;
  const Stat = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="rounded-lg border border-border bg-bg/40 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-muted">{k}</div>
      <div className="mt-0.5 text-sm font-medium text-white">{v}</div>
    </div>
  );

  return (
    <>
      <div className="col-span-12 flex flex-wrap gap-1.5">
        {([['status', 'Status'], ['logs', 'Log Search'], ['backups', 'Backups'], ['ha', 'Replication & HA']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setSub(id)} className={`rounded-lg border px-3 py-1.5 text-xs transition ${sub === id ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted hover:text-white'}`}>{label}</button>
        ))}
      </div>

      {/* Primary database status */}
      {sub === 'status' && <Card title="Database" className="col-span-12 lg:col-span-6">
        <div className="space-y-3 text-xs">
          <div className="flex items-center gap-2">
            {dot(!!s?.ok)}
            <span className="font-medium text-white">{s?.engine ?? 'PostgreSQL'} — primary</span>
            <span className={`rounded px-1.5 py-0.5 text-2xs ${s?.ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>{s?.ok ? 'connected' : 'unreachable'}</span>
          </div>
          {s?.error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{s.error}</div>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat k="Size" v={s?.size ?? '—'} />
            <Stat k="Uptime" v={s?.uptime ?? '—'} />
            <Stat k="Replication" v={s?.replication?.mode ?? '—'} />
          </div>
          <div className="text-2xs text-muted">{s?.version || 'PostgreSQL 16'}</div>
          <div className="rounded-lg border border-brand/25 bg-brand/5 px-3 py-2 text-2xs text-muted-light">
            <b className="text-brand">Replication / sync:</b> {s?.replication?.mode === 'standalone' ? 'standalone (no replica configured).' : `${s?.replication?.replicas ?? 0} replica(s) connected.`} A streaming read-replica can be attached for HA/read scaling.
            <div className="mt-1">{s?.logStore?.ok
              ? <><b className="text-success">Log store:</b> a dedicated <b className="text-white">ClickHouse</b> log database is active alongside Postgres — {number(s.logStore.rows)} log rows, {s.logStore.retention}. See the card below.</>
              : <><b className="text-brand">Log store:</b> provisioning a dedicated <b className="text-white">ClickHouse</b> log database for far faster log search/aggregation — it appears below with its own status, retention (TTL) and sync.</>}</div>
          </div>
        </div>
      </Card>}

      {/* ClickHouse log store */}
      {sub === 'status' && <LogStoreCard s={s} />}

      {/* Fast log search (ClickHouse) */}
      {sub === 'logs' && <LogSearchCard />}

      {/* Backups */}
      {sub === 'backups' && <Card title="Backups" className="col-span-12 lg:col-span-6" action={<div className="flex gap-2">
        <button onClick={runFullSnapshot} disabled={fullSnapshot.isPending} className="rounded-lg border border-brand/40 bg-brand/10 px-3 py-1.5 text-xs font-medium text-brand hover:text-white disabled:opacity-50" title="Bundle docker images + source code + database into one restore-anywhere archive">{fullSnapshot.isPending ? 'Snapshotting…' : '⬢ Full snapshot'}</button>
        <button onClick={runBackup} disabled={backupNow.isPending} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{backupNow.isPending ? 'Backing up…' : '↻ Backup now'}</button>
      </div>}>
        <div className="space-y-2 text-xs">
          <div className="text-2xs text-muted">Daily automated <b className="text-white">DB</b> backup (keeps the last 7), plus on-demand. <b className="text-white">Full snapshot</b> bundles docker images + source code + DB. <b className="text-white">⤓ Download</b> any backup to your computer, or set an off-server destination below. Restore a DB dump with <span className="font-mono">gunzip &lt; file | psql</span>.</div>
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-bg/40 p-2.5">
            <div className="min-w-[260px] flex-1">
              <label className="mb-1 block text-2xs text-muted">Off-server backup path (don&apos;t keep backups only on this server) — mount an <b className="text-white">NFS / network share</b> into the container at this path</label>
              <input value={extPath ?? s?.backupExternalPath ?? ''} onChange={(e) => setExtPath(e.target.value)} placeholder="/mnt/nfs-backups" className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
            </div>
            <button onClick={() => setBackupCfg.mutate(extPath ?? s?.backupExternalPath ?? '', { onSuccess: () => setExtPath(null) })} disabled={setBackupCfg.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50">Save</button>
            <div className="w-full text-2xs text-muted">Each backup + full snapshot is also copied here. Local store: <span className="font-mono">{s?.backupDir ?? '/backups'}</span>{s?.backupExternalPath ? <> · off-server copy: <span className="font-mono text-emerald-300">{s.backupExternalPath}</span></> : ''}. To use NFS, add a bind/volume mount for the share to the <span className="font-mono">api</span> &amp; <span className="font-mono">backup</span> services pointing at this path.</div>
          </div>
          {msg && <div className="rounded-lg border border-border bg-card/60 px-2 py-1 text-2xs text-muted-light">{msg}</div>}
          <div className="max-h-56 overflow-auto rounded-lg border border-border">
            {(backups.data ?? []).length === 0 ? (
              <div className="px-3 py-6 text-center text-2xs text-muted">No backups yet — the daily job runs on the next cycle, or click <b className="text-white">Backup now</b>.</div>
            ) : (
              <table className="w-full text-2xs">
                <tbody>
                  {(backups.data ?? []).map((b) => (
                    <tr key={b.name} className="border-t border-border-soft first:border-0">
                      <td className="px-3 py-1.5 font-mono text-white">{b.name}{b.full ? <span className="ml-1 rounded bg-emerald-500/15 px-1 text-emerald-300">full</span> : b.manual && <span className="ml-1 rounded bg-brand/15 px-1 text-brand">manual</span>}</td>
                      <td className="px-3 py-1.5 text-right text-muted-light">{fmtBytes(b.bytes)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{timeAgo(b.at)}</td>
                      <td className="px-3 py-1.5 text-right"><button onClick={() => downloadBackup.mutate(b.name)} disabled={downloadBackup.isPending} className="rounded border border-border bg-card px-1.5 py-0.5 text-2xs text-brand hover:text-white disabled:opacity-50" title="Download to your computer (off-server)">⤓ Download</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Card>}

      {/* Configuration export/import — kept with the DB backups so all backup/restore lives in one place */}
      {sub === 'backups' && <BackupPanel />}

      {/* HA cluster */}
      {sub === 'ha' && <ClusterPanel />}

      {/* Replication & Failover */}
      {sub === 'ha' && <FailoverCard />}

      {/* Tables & log growth */}
      {sub === 'status' && <Card title="Tables & log growth" className="col-span-12" bodyClassName="p-0">
        <div className="border-b border-border px-4 py-2 text-2xs text-muted">Largest tables. <span className="text-brand">Log tables</span> are auto-purged by retention (operational logs at the configured window; the security audit trail is kept ~4× longer for compliance).</div>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-2xs">
            <thead><tr className="sticky top-0 bg-card text-left text-muted"><th className="px-4 py-1.5 font-medium">Table</th><th className="px-4 py-1.5 text-right font-medium">Rows</th><th className="px-4 py-1.5 text-right font-medium">Size</th></tr></thead>
            <tbody>
              {(s?.tables ?? []).map((t) => (
                <tr key={t.name} className="border-t border-border-soft">
                  <td className="px-4 py-1.5 font-mono"><span className={t.isLog ? 'text-brand' : 'text-white'}>{t.name}</span>{t.isLog && <span className="ml-1.5 rounded bg-brand/15 px-1 text-brand">log</span>}</td>
                  <td className="px-4 py-1.5 text-right text-muted-light">{t.rows.toLocaleString()}</td>
                  <td className="px-4 py-1.5 text-right text-muted-light">{t.size}</td>
                </tr>
              ))}
              {(s?.tables ?? []).length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-muted">No table stats available.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>}
    </>
  );
}

/** Enter a standby VM IP → generate a complete, tailored failover/HA setup guide. */
function FailoverCard() {
  const gen = useFailoverGuide();
  const [ip, setIp] = useState('');
  const [copied, setCopied] = useState(false);
  const data = gen.data;
  const run = () => { setCopied(false); gen.mutate(ip.trim()); };
  const copy = async () => { if (data) { const ok = await copyText(data.markdown); setCopied(ok); setTimeout(() => setCopied(false), 1800); } };
  return (
    <Card title="Replication & Failover" className="col-span-12">
      <div className="space-y-3 text-xs">
        <div className="text-2xs text-muted">Point MCMF at a second VM and get a complete, copy-paste <b className="text-white">failover setup guide</b> — PostgreSQL streaming replication (hot standby) + the full app stack, promotion and traffic redirect, all pre-filled with your IPs.</div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="mb-1 block text-2xs text-muted">Standby (failover) VM IP / hostname</label>
            <input value={ip} onChange={(e) => setIp(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="e.g. 10.0.0.20" className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
          </div>
          <button onClick={run} disabled={gen.isPending || !ip.trim()} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{gen.isPending ? 'Generating…' : 'Generate setup guide'}</button>
        </div>
        {gen.isError && <div className="rounded-lg border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{(gen.error as Error).message}</div>}
        {data && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg/40 px-3 py-2 text-2xs">
              <span className="text-muted">Primary <b className="font-mono text-white">{data.primaryIp}</b> → Standby <b className="font-mono text-white">{data.standbyIp}</b></span>
              <span className="text-muted">· repl user <span className="font-mono text-muted-light">{data.replUser}</span> · password <span className="font-mono text-warning">{data.replPassword}</span></span>
              <button onClick={copy} className="ml-auto rounded-md border border-border bg-card px-2.5 py-1 text-brand hover:text-white">{copied ? 'Copied ✓' : '⧉ Copy'}</button>
              <button onClick={() => downloadText(`mcmf-failover-${data.standbyIp}.md`, data.markdown)} className="rounded-md bg-brand px-2.5 py-1 font-medium text-white hover:bg-brand-soft">⤓ Download .md</button>
            </div>
            <pre className="max-h-96 select-all overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-2xs leading-relaxed text-muted-light">{data.markdown}</pre>
          </div>
        )}
      </div>
    </Card>
  );
}

function StatBox({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg/40 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-muted">{k}</div>
      <div className="mt-0.5 text-sm font-medium text-white">{v}</div>
    </div>
  );
}

/** The ClickHouse log database — status, retention (TTL) and sync, alongside Postgres. */
function LogStoreCard({ s }: { s: any }) {
  const ls = s?.logStore;
  const ok = !!ls?.ok;
  return (
    <Card title="ClickHouse — log store" className="col-span-12 lg:col-span-6">
      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: ok ? '#22c55e' : '#f59e0b' }} />
          <span className="font-medium text-white">ClickHouse — {ls?.role ?? 'log analytics store'}</span>
          <span className={`rounded px-1.5 py-0.5 text-2xs ${ok ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>{ok ? 'active' : ls?.provisioning ? 'provisioning…' : 'unreachable'}</span>
        </div>
        {!ok && ls?.error && <div className="rounded-lg border border-warning/30 bg-warning/10 px-2 py-1 text-2xs text-warning">{ls.error}</div>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatBox k="Log rows" v={ok ? number(ls.rows) : '—'} />
          <StatBox k="On disk" v={ok ? ls.size : '—'} />
          <StatBox k="Retention" v={ls?.retention ?? `${ls?.retentionDays ?? 30} days (TTL)`} />
          <StatBox k="Last log" v={ls?.lastTs ? timeAgo(ls.lastTs.replace(' ', 'T') + 'Z') : '—'} />
        </div>
        {ok && (ls.bySource?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {ls.bySource.map((b: any) => (
              <span key={b.source} className="rounded border border-border bg-bg/40 px-2 py-0.5 text-2xs text-muted-light">{b.source}: <b className="text-white">{number(b.count)}</b></span>
            ))}
          </div>
        )}
        <div className="rounded-lg border border-brand/25 bg-brand/5 px-3 py-2 text-2xs text-muted-light">
          <b className="text-brand">Sync:</b> {ls?.sync ?? 'CDC from Postgres log tables'} (every 60s). <b className="text-brand">Retention:</b> rows auto-expire via ClickHouse TTL after {ls?.retentionDays ?? 30} days.{ls?.version && <span className="text-muted"> · {ls.version}</span>}
        </div>
      </div>
    </Card>
  );
}

/** Copy-paste runbook modal (setup / promotion). */
function RunbookModal({ title, markdown, onClose }: { title: string; markdown: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { const ok = await copyText(markdown); setCopied(ok); setTimeout(() => setCopied(false), 1600); };
  return (
    <Modal title={title} subtitle="Copy-paste runbook" onClose={onClose} wide>
      <div className="flex justify-end gap-2 pb-2">
        <button onClick={copy} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-brand hover:text-white">{copied ? 'Copied ✓' : '⧉ Copy'}</button>
        <button onClick={() => downloadText(`${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`, markdown)} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white">⤓ Download .md</button>
      </div>
      <pre className="max-h-[60vh] select-all overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-2xs leading-relaxed text-muted-light">{markdown}</pre>
    </Modal>
  );
}

/** Small status pill for a node's auto-deploy state. */
function DeployRow({ d }: { d: DeployRecord }) {
  const [showFiles, setShowFiles] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const notes = useReleaseNotes();
  const files = d.files ?? [];
  const cc = (c: string) => (c === '+' ? 'text-emerald-300' : c === '-' ? 'text-rose-300' : 'text-amber-300');
  return (
    <div className="px-3 py-1.5 text-2xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={`rounded px-1.5 py-0.5 font-mono ${d.status === 'deployed' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>{d.version}</span>
        <span className="text-muted">{d.sourceHost || '—'}</span>
        <span className="text-muted-light">→</span>
        <span className="text-white">{d.targetName || d.targetHost}</span>
        <span className="text-muted-light">·</span>
        <span className="text-muted">{d.kind}</span>
        <span className="ml-auto text-muted" title={new Date(d.at).toLocaleString()}>🕐 {clock(d.at)} · {timeAgo(d.at)}</span>
      </div>
      {d.changes && <div className="mt-0.5 break-words pl-1 text-muted-light/80" title={d.changes}>↳ {d.changes}</div>}
      <div className="mt-1 flex items-center gap-2 pl-1">
        {!!files.length && <button onClick={() => setShowFiles((s) => !s)} className="text-brand hover:underline">{showFiles ? 'Hide' : 'Show'} {files.length} file{files.length === 1 ? '' : 's'}</button>}
        <button onClick={() => { setNotesOpen(true); if (!notes.data) notes.mutate({ files, version: d.version }); }} className="rounded border px-1.5 py-0.5 font-medium" style={{ borderColor: '#a855f766', color: '#c084fc' }}>🧠 AI release notes</button>
      </div>
      {showFiles && !!files.length && (
        <div className="mt-1 max-h-40 overflow-auto rounded border border-border bg-bg/40 p-2 font-mono text-2xs">
          {files.map((f, i) => <div key={i} className="truncate"><span className={cc(f.c)}>{f.c}</span> {f.p}</div>)}
        </div>
      )}
      {notesOpen && (
        <Modal wide onClose={() => setNotesOpen(false)} title={`🧠 Release notes — ${d.version}`}>
          {notes.isPending ? (
            <div className="py-8 text-center text-2xs text-muted">Generating release notes… (first run can take ~1–2 min on a cold model)</div>
          ) : notes.isError ? (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-3 text-2xs text-danger">Could not generate notes — the feature-area summary above still applies.</div>
          ) : notes.data ? (
            <div className="space-y-2">
              <div className="text-2xs text-muted">{files.length} changed file(s) · {notes.data.source === 'rules' ? 'native engine' : `via ${notes.data.model}`}</div>
              {notes.data.note && <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-2xs text-warning">{notes.data.note}</div>}
              <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg/40 p-3 text-2xs leading-relaxed text-muted-light">{notes.data.notes}</div>
              <div className="text-2xs text-muted">AI-inferred from the changed file paths for this build — review before publishing externally.</div>
            </div>
          ) : null}
        </Modal>
      )}
    </div>
  );
}

function DeployBadge({ status }: { status: ClusterNodeStatus['deployStatus'] }) {
  const map: Record<ClusterNodeStatus['deployStatus'], { label: string; cls: string; dot?: boolean }> = {
    none: { label: 'not deployed', cls: 'bg-border/30 text-muted' },
    deploying: { label: 'deploying', cls: 'bg-amber-500/15 text-amber-300', dot: true },
    deployed: { label: 'deployed', cls: 'bg-emerald-500/15 text-emerald-300' },
    failed: { label: 'failed', cls: 'bg-danger/15 text-danger' },
  };
  const s = map[status] ?? map.none;
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${s.cls}`}>{s.dot && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />}{s.label}</span>;
}

/** Development / Test / Production environment badge. */
function EnvBadge({ env }: { env: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    production: { label: 'Production', cls: 'bg-rose-500/15 text-rose-300' },
    test: { label: 'Test', cls: 'bg-amber-500/15 text-amber-300' },
    development: { label: 'Development', cls: 'bg-indigo-500/15 text-indigo-300' },
  };
  const s = map[env] ?? map.development;
  return <span className={`rounded px-1.5 py-0.5 font-medium ${s.cls}`}>{s.label}</span>;
}

/** Replication / sync state for a node. Full-clone replicas show "in sync (cloned <ago>)". */
function SyncCell({ n }: { n: ClusterNodeStatus }) {
  if (n.role === 'primary') return <span className="text-muted-light">— (writer)</span>;
  if (n.replState) return <span className="text-muted-light">{n.replState}{n.lag ? ` · lag ${n.lag}` : ''}</span>;
  if (n.deployStatus === 'deployed') {
    const codeAt = n.lastDeployAt || n.lastSyncAt; // last CODE/version update time
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="inline-flex items-center gap-1 text-emerald-300" title={n.lastDeployAt ? `Code last updated ${new Date(n.lastDeployAt).toLocaleString()}` : n.lastSyncAt ? `Last synced ${new Date(n.lastSyncAt).toLocaleString()}` : 'Cloned from primary'}>
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />in sync{codeAt ? ` · ${timeAgo(codeAt)}` : ' (cloned)'}
        </span>
        {(codeAt || n.lastDeployVersion) && (
          <span className="inline-flex flex-wrap items-center gap-1 text-2xs">
            {codeAt && <span className="text-muted" title="Build update time (your local timezone)">🕐 {clock(codeAt)}</span>}
            {n.lastDeployVersion && <span className="rounded bg-indigo-500/15 px-1 font-mono text-indigo-200" title={`Build received from ${n.lastDeploySource || 'source'}`}>🏷 {n.lastDeployVersion}</span>}
          </span>
        )}
        {n.lastDeploySource && <span className="text-2xs text-muted">from {n.lastDeploySource}</span>}
      </span>
    );
  }
  if (n.deployStatus === 'deploying') return <span className="text-amber-300">syncing… {n.deployProgress ?? 0}%</span>;
  if (n.syncPaused) return <span className="text-rose-300/90" title="Sync stopped by operator">⏸ sync stopped</span>;
  return <span className="text-muted">not synced</span>;
}

/** Live auto-deploy progress log for a node (polled). */
function DeployLogModal({ node, onClose }: { node: ClusterNodeStatus; onClose: () => void }) {
  return (
    <Modal title={`Auto-deploy — ${node.name} (${node.host})`} subtitle={node.deployStatus === 'deploying' ? 'In progress — live progress below' : `Status: ${node.deployStatus}`} onClose={onClose} wide>
      <div className="mb-2 flex items-center gap-2 text-2xs"><DeployBadge status={node.deployStatus} />{node.deployStatus === 'deploying' && <span className="text-muted">building the full stack can take several minutes…</span>}</div>
      {(node.deployStatus === 'deploying' || (node.deployProgress ?? 0) > 0) && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between text-2xs"><span className="font-medium text-indigo-200">{node.deployStatus === 'deploying' ? '⇧ Sending to production…' : node.deployStatus === 'deployed' ? '✅ Synced' : 'Last run'}</span><span className="font-mono tabular-nums text-white">{node.deployProgress ?? 0}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-700" style={{ width: `${node.deployProgress ?? 0}%` }} /></div>
        </div>
      )}
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg p-3 font-mono text-2xs leading-relaxed text-muted-light">{node.deployLog?.trim() || 'Waiting for the first step…'}</pre>
    </Modal>
  );
}

/** Save / replace SSH credentials for an already-registered node. */
function CredsModal({ node, onClose, onSave, saving }: { node: ClusterNodeStatus; onClose: () => void; onSave: (b: { sshUser: string; sshPassword: string; sshPort: number }) => void; saving: boolean }) {
  const [u, setU] = useState(node.sshUser ?? '');
  const [p, setP] = useState('');
  const [port, setPort] = useState(String(node.sshPort || 22));
  return (
    <Modal title={`SSH credentials — ${node.name}`} subtitle="Used for one-click auto-deploy over SSH" onClose={onClose}>
      <div className="space-y-3 text-xs">
        <div className="text-2xs text-muted">Stored sealed (AES-256-GCM) on the server and never returned to the browser. {node.hasCreds && <span className="text-emerald-300/80">Credentials are currently saved.</span>}</div>
        <div><label className="mb-1 block text-2xs text-muted">SSH user</label><input value={u} onChange={(e) => setU(e.target.value)} autoComplete="off" placeholder="ubuntu / azureuser" className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white" /></div>
        <div><label className="mb-1 block text-2xs text-muted">SSH / sudo password</label><PasswordInput value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" placeholder={node.hasCreds ? '•••••••• (leave blank to keep)' : '••••••••'} className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white" /></div>
        <div><label className="mb-1 block text-2xs text-muted">Port</label><input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="22" className="w-24 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white" /></div>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs text-muted hover:text-white">Cancel</button><button onClick={() => onSave({ sshUser: u, sshPassword: p, sshPort: Number(port) || 22 })} disabled={saving || !u.trim()} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50">Save credentials</button></div>
      </div>
    </Modal>
  );
}

/** HA cluster panel — register nodes, live topology + lag, CNAME, per-node setup & promotion runbooks. */
function ClusterPanel() {
  const cluster = useCluster();
  const addNode = useAddClusterNode();
  const removeNode = useRemoveClusterNode();
  const setCname = useSetClusterCname();
  const setup = useNodeSetup();
  const promote = usePromoteExec();
  const resync = useResyncNode();
  const deploy = useDeployNode();
  const setCreds = useSetNodeCreds();
  const syncToProd = useSyncToProd();
  const setNodeEnv = useSetNodeEnv();
  const setEnvLabel = useSetEnvLabel();
  const setSyncPaused = useSetNodeSyncPaused();
  const [name, setName] = useState(''); const [host, setHost] = useState(''); const [role, setRole] = useState('replica'); const [subnet, setSubnet] = useState('');
  const [sshUser, setSshUser] = useState(''); const [sshPassword, setSshPassword] = useState(''); const [sshPort, setSshPort] = useState('22');
  const [cnameInput, setCnameInput] = useState<string | null>(null);
  const [runbook, setRunbook] = useState<{ title: string; markdown: string } | null>(null);
  const [logNode, setLogNode] = useState<ClusterNodeStatus | null>(null);
  const [credsNode, setCredsNode] = useState<ClusterNodeStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const c = cluster.data;
  const cname = cnameInput ?? c?.cname ?? '';
  const nodes = c?.nodes ?? [];
  // Keep the live-log modal in sync with polled cluster data.
  const liveLogNode = logNode ? nodes.find((n) => n.id === logNode.id) ?? logNode : null;

  const add = async () => {
    setErr(null);
    try {
      await addNode.mutateAsync({ name, host, role, subnet, sshUser, sshPassword, sshPort: Number(sshPort) || 22 });
      setName(''); setHost(''); setSubnet(''); setRole('replica'); setSshUser(''); setSshPassword(''); setSshPort('22');
    } catch (e) { setErr((e as Error).message); }
  };
  const openSetup = async (id: string, label: string) => { try { const r = await setup.mutateAsync(id); setRunbook({ title: `Setup — ${label}`, markdown: r.markdown }); } catch (e) { setErr((e as Error).message); } };
  const runDeploy = async (n: ClusterNodeStatus) => {
    setErr(null);
    if (!confirm(`Auto-deploy a full MCMF clone onto ${n.name} (${n.host})?\n\nThis installs Docker, clones the app, copies this server's secrets + a fresh database snapshot, and builds the stack. Any existing MCMF on that host is replaced.`)) return;
    try { await deploy.mutateAsync({ id: n.id }); setLogNode(n); } catch (e) { setErr((e as Error).message); }
  };
  const runResync = async (n: ClusterNodeStatus) => {
    setErr(null);
    if (!confirm(`Re-sync ${n.name} (${n.host}) from the primary?\n\nThis refreshes the replica's database with a fresh snapshot from this server (data only — no rebuild). The replica briefly restarts.`)) return;
    try { await resync.mutateAsync(n.id); setLogNode(n); } catch (e) { setErr((e as Error).message); }
  };
  const runPromote = async (n: ClusterNodeStatus) => {
    setErr(null);
    if (!confirm(`Promote ${n.name} (${n.host}) to PRIMARY?\n\nIts database becomes read-write and it takes over as the active platform; the current primary becomes a replica. Agents & clients follow via the cluster CNAME/VIP.`)) return;
    try { const r = await promote.mutateAsync(n.id); alert(r.message); } catch (e) { setErr((e as Error).message); }
  };
  const runSyncToProd = async (n: ClusterNodeStatus) => {
    setErr(null);
    if (!confirm(`Promote Development → Production onto ${n.name} (${n.host})?\n\nThis raises an APPROVAL request. Once approved, it deploys this server's CODE + CONFIG (alert rules, automations, policies, dashboards, branding). Production's own data is PRESERVED — users & 2FA, cloud connections, discovered VMs, credentials and history are NOT touched. It does NOT sync until approved.`)) return;
    try { const r = await syncToProd.mutateAsync(n.id); alert(r.message); if (!r.gated) setLogNode(n); } catch (e) { setErr((e as Error).message); }
  };
  // Stop/Resume sync is a critical change — confirm before stopping.
  const toggleSyncPause = (n: ClusterNodeStatus) => {
    const stopping = !n.syncPaused;
    if (stopping && !confirm(`Stop syncing to ${n.name} (${n.host})?\n\nDeploy, Re-sync and Sync to Production for this node will be BLOCKED until you resume. Use this to freeze a node during maintenance.`)) return;
    setSyncPaused.mutate({ id: n.id, paused: stopping });
  };

  return (
    <Card title="HA Cluster — 1 primary + up to 4 replicas" className="col-span-12"
      action={c?.build ? <span className="rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-2xs font-medium text-indigo-200" title="Current build version on this server (CI/CD). Each deploy/sync bumps the build and stamps the target with the version + source server.">🏷 {c.build}</span> : undefined}>
      <div className="space-y-4 text-xs">
        <div className="text-2xs text-muted">Each node runs the full app stack independently as a clone of the primary (data + code). Add a node with SSH creds and <b className="text-emerald-300/90">Deploy</b> to provision it automatically; <b className="text-sky-300/90">Re-sync</b> refreshes its data on demand; <b className="text-warning">Promote</b> fails it over to primary (executes over SSH) and repoints agents &amp; clients via the CNAME/VIP. Works across subnets.</div>

        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-bg/40 p-3">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block text-2xs text-muted">Cluster CNAME / floating VIP (agents &amp; clients target this)</label>
            <input value={cname} onChange={(e) => setCnameInput(e.target.value)} placeholder="e.g. mcmf.yourco.local" className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
          </div>
          <button onClick={() => setCname.mutate(cname, { onSuccess: () => setCnameInput(null) })} disabled={setCname.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50">Save</button>
          <div className="w-full flex flex-wrap items-center gap-2 text-2xs text-muted">
            <span>This server: <EnvBadge env={c?.envLabel ?? 'production'} /></span>
            <select value={c?.envLabel ?? 'production'} onChange={(e) => setEnvLabel.mutate(e.target.value)} disabled={setEnvLabel.isPending} title="A Development server is the control plane — it deploys/syncs to Test & Production targets. Test/Production servers are passive targets." className="rounded border border-border bg-bg px-1.5 py-0.5 text-white focus:border-brand focus:outline-none disabled:opacity-50">
              <option value="development">Development (control plane — dev &amp; test)</option>
              <option value="test">Test</option>
              <option value="production">Production</option>
            </select>
            <span className="font-mono text-white">{c?.primaryHost ?? '—'}</span>
            <span>· {c?.replicasConnected ?? 0} replica(s) streaming.</span>
            {c && !c.canOrchestrate && <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-rose-300/90" title="This server can't reach Development, so deploy/setup/promote/sync run from the Development server. Here you only see last-sync time + Stop sync.">limited — this is a target, not the control plane</span>}
          </div>
        </div>
        <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2 text-2xs text-indigo-200/90">⇧ <b>Dev → Prod (selective):</b> mark this server <b>Development</b> and a node <b>Production</b>, then use <b className="text-indigo-300">Sync to Production</b>. After <b>approval</b> it promotes <b>code + config</b> (alert rules, automations, policies, dashboards, branding) and <b>preserves prod&apos;s own data</b> — users &amp; 2FA, cloud connections, discovered VMs, credentials and history are never overwritten. (First-time stand-up of a prod node = the full-clone <b>Deploy</b>.)</div>

        {/* CI/CD deploy history — version + source + target for each promotion, recorded on both ends. */}
        {!!(c?.deploys && c.deploys.length) && (
          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-3 py-1.5 text-2xs font-semibold text-white">🏷 Deploy history (CI/CD)</div>
            <div className="max-h-72 divide-y divide-border-soft overflow-auto">
              {c.deploys!.map((d, i) => <DeployRow key={i} d={d} />)}
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-2xs">
            <thead><tr className="border-b border-border text-left text-muted"><th className="px-3 py-1.5 font-medium">Node</th><th className="px-3 py-1.5 font-medium">Host</th><th className="px-3 py-1.5 font-medium">Env</th><th className="px-3 py-1.5 font-medium">Role</th><th className="px-3 py-1.5 font-medium">Health</th><th className="px-3 py-1.5 font-medium">Replication</th><th className="px-3 py-1.5 font-medium">Deploy</th><th className="px-3 py-1.5 font-medium">Subnet</th><th className="px-3 py-1.5"></th></tr></thead>
            <tbody>
              {nodes.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-5 text-center text-muted">No nodes yet. Add this server + each standby below (max 5).</td></tr>
              ) : nodes.map((n) => (
                <tr key={n.id} className="border-t border-border-soft">
                  <td className="px-3 py-1.5 text-white">{n.name}</td>
                  <td className="px-3 py-1.5 font-mono text-muted-light">{n.host}</td>
                  <td className="px-3 py-1.5">{c?.canOrchestrate ? (
                    <select value={n.environment} onChange={(e) => setNodeEnv.mutate({ id: n.id, environment: e.target.value })} title="Tag this node's environment" className="rounded border border-border bg-bg px-1 py-0.5 text-2xs text-white focus:border-brand focus:outline-none">
                      <option value="development">Development</option>
                      <option value="test">Test</option>
                      <option value="production">Production</option>
                    </select>
                  ) : <EnvBadge env={n.environment} />}</td>
                  <td className="px-3 py-1.5"><span className={`rounded px-1.5 py-0.5 ${n.role === 'primary' ? 'bg-brand/15 text-brand' : 'bg-border/40 text-muted-light'}`}>{n.role}</span></td>
                  <td className="px-3 py-1.5"><span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: n.reachable ? '#22c55e' : '#ef4444' }} />{n.reachable ? 'reachable' : 'down'}</span></td>
                  <td className="px-3 py-1.5"><SyncCell n={n} /></td>
                  <td className="px-3 py-1.5">
                    {n.role === 'primary' ? <span className="text-muted">—</span> : (
                      <button onClick={() => n.deployStatus === 'none' && !n.deployLog ? undefined : setLogNode(n)} className="inline-flex items-center gap-1" title={n.deployStatus === 'none' && !n.deployLog ? '' : 'View deploy log'}>
                        <DeployBadge status={n.deployStatus} />
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-muted">{n.subnet || '—'}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex justify-end gap-1">
                      {/* Per-node gating by reachability: a node this server can't reach (e.g. Dev from Prod)
                          shows only last-sync + Stop sync. A reachable node (incl. a Prod's own HA replica)
                          shows the full deploy/setup/promote actions. "Sync to Prod/Test" is the Dev control-
                          plane config-promotion, so it also needs this server to be Development. */}
                      {n.role === 'primary' ? (
                        <span className="text-muted">— (this node)</span>
                      ) : !n.reachable ? (
                        // Limited view — target unreachable from here (prod can't reach dev).
                        <>
                          <span className="text-muted" title={n.lastSyncAt ? `last sync ${new Date(n.lastSyncAt).toLocaleString()}` : 'unreachable from this server'}>{n.lastSyncAt ? `last sync ${timeAgo(n.lastSyncAt)}` : 'unreachable'}</span>
                          <button onClick={() => toggleSyncPause(n)} disabled={setSyncPaused.isPending} className={`rounded border px-1.5 py-0.5 hover:text-white disabled:opacity-50 ${n.syncPaused ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'}`} title={n.syncPaused ? 'Resume syncing to this node' : 'Stop syncing to this node'}>{n.syncPaused ? '▶ Resume' : '⏸ Stop sync'}</button>
                        </>
                      ) : (
                        <>
                          {c?.canOrchestrate && (n.environment === 'production' || n.environment === 'test') && (
                            <button onClick={() => runSyncToProd(n)} disabled={syncToProd.isPending || n.deployStatus === 'deploying' || !n.hasCreds || n.syncPaused} className="rounded border border-indigo-500/50 bg-indigo-500/15 px-1.5 py-0.5 font-medium text-indigo-200 hover:text-white disabled:opacity-50" title={n.syncPaused ? 'Sync is stopped — resume it first' : `Mirror Development → ${n.environment === 'test' ? 'Test' : 'Production'} (approval-gated)`}>⇧ Sync to {n.environment === 'test' ? 'Test' : 'Production'}</button>
                          )}
                          {/* First-time stand-up only. Re-deploy is removed — a full clone wipes the
                              target's data; for an already-deployed node use Re-sync (data) or Sync to
                              Production (config), which preserve it. */}
                          {n.deployStatus !== 'deployed' && (
                            <button onClick={() => runDeploy(n)} disabled={n.deployStatus === 'deploying' || n.syncPaused} className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300 hover:text-white disabled:opacity-50" title="First-time stand-up: install + clone the full platform onto this node over SSH">
                              {n.deployStatus === 'deploying' ? `Deploying… ${n.deployProgress ?? 0}%` : n.hasCreds ? 'Deploy' : 'Deploy…'}
                            </button>
                          )}
                          {/* Re-sync is a full data clone — only for SAME-environment HA replicas
                              (prod→prod, dev→dev). Hidden across environments (e.g. dev→prod), where it
                              would overwrite real data — use Sync to Production there. */}
                          {n.deployStatus === 'deployed' && c?.envLabel === n.environment && (
                            <button onClick={() => runResync(n)} disabled={resync.isPending} className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-sky-300 hover:text-white disabled:opacity-50" title="Refresh this same-environment HA replica's data from the primary (full data clone, no rebuild)">Re-sync</button>
                          )}
                          <button onClick={() => setCredsNode(n)} className="rounded border border-border bg-card px-1.5 py-0.5 text-muted-light hover:text-white" title="SSH credentials">🔑</button>
                          <button onClick={() => openSetup(n.id, n.name)} className="rounded border border-border bg-card px-1.5 py-0.5 text-brand hover:text-white">Setup</button>
                          <button onClick={() => runPromote(n)} disabled={promote.isPending || n.deployStatus !== 'deployed'} className="rounded border border-border bg-card px-1.5 py-0.5 text-warning hover:text-white disabled:opacity-40" title={n.deployStatus !== 'deployed' ? 'Deploy this replica before it can be promoted' : 'Promote this replica to primary (executes over SSH)'}>Promote</button>
                          <button onClick={() => toggleSyncPause(n)} disabled={setSyncPaused.isPending} className={`rounded border px-1.5 py-0.5 hover:text-white disabled:opacity-50 ${n.syncPaused ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'}`} title={n.syncPaused ? 'Resume syncing to this node' : 'Stop syncing to this node'}>{n.syncPaused ? '▶ Resume' : '⏸ Stop sync'}</button>
                        </>
                      )}
                      <button onClick={() => confirm(`Remove ${n.name} from the cluster registry?`) && removeNode.mutate(n.id)} className="rounded border border-border bg-card px-1.5 py-0.5 text-muted hover:text-danger" title="Remove">✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {nodes.length < (c?.maxNodes ?? 5) && (
          <div className="flex flex-wrap items-end gap-2">
            <div><label className="mb-1 block text-2xs text-muted">Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="node-2" className="w-28 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white" /></div>
            <div><label className="mb-1 block text-2xs text-muted">IP / hostname</label><input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="192.168.x.x or fqdn" className="w-44 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white" /></div>
            <div><label className="mb-1 block text-2xs text-muted">Role</label><select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white"><option value="replica">replica</option><option value="primary">primary</option></select></div>
            <div><label className="mb-1 block text-2xs text-muted">Subnet (optional)</label><input value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="10.0.2.0/24" className="w-32 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white" /></div>
            <div className="w-full" />
            <div><label className="mb-1 block text-2xs text-emerald-300/80">SSH user (for auto-deploy)</label><input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="ubuntu / azureuser" autoComplete="off" className="w-32 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white" /></div>
            <div><label className="mb-1 block text-2xs text-emerald-300/80">SSH / sudo password</label><input type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" className="w-40 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white" /></div>
            <div><label className="mb-1 block text-2xs text-emerald-300/80">Port</label><input value={sshPort} onChange={(e) => setSshPort(e.target.value.replace(/\D/g, ''))} placeholder="22" className="w-16 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white" /></div>
            <button onClick={add} disabled={addNode.isPending || !host.trim()} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50">+ Add node</button>
            <div className="w-full text-2xs text-muted">Enter SSH credentials to enable <b className="text-emerald-300/90">one-click auto-deploy</b> — the platform installs Docker, clones itself, copies this server&apos;s secrets + a live database snapshot, and builds the full stack on the new node. Leave blank to register the node for runbook-only setup.</div>
          </div>
        )}
        {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{err}</div>}
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-2xs text-amber-300/90">⚠ PostgreSQL HA is single-writer (1 primary + read replicas) — true write-anywhere multi-master needs a different engine. "No impact on primary failure" = promote a standby (the per-node <b>Promote</b> runbook does this) and the CNAME/VIP repoints agents &amp; clients automatically, across subnets.</div>
      </div>

      {runbook && <RunbookModal title={runbook.title} markdown={runbook.markdown} onClose={() => setRunbook(null)} />}
      {liveLogNode && <DeployLogModal node={liveLogNode} onClose={() => setLogNode(null)} />}
      {credsNode && (
        <CredsModal
          node={credsNode}
          saving={setCreds.isPending}
          onClose={() => setCredsNode(null)}
          onSave={async (b) => { setErr(null); try { await setCreds.mutateAsync({ id: credsNode.id, body: b }); setCredsNode(null); } catch (e) { setErr((e as Error).message); } }}
        />
      )}
    </Card>
  );
}

/** Fast log search over the ClickHouse log store. */
function LogSearchCard() {
  const search = useLogSearch();
  const [q, setQ] = useState('');
  const [source, setSource] = useState('all');
  const d = search.data;
  const run = () => search.mutate({ q: q.trim() || undefined, source, limit: 50 });
  return (
    <Card title="Log search (ClickHouse)" className="col-span-12 lg:col-span-6">
      <div className="space-y-2 text-xs">
        <div className="flex flex-wrap gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="Search message / host / level…" className="min-w-[160px] flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
          <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-white">
            {['all', 'event', 'siem', 'audit'].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <button onClick={run} disabled={search.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{search.isPending ? 'Searching…' : 'Search'}</button>
        </div>
        {d && <div className="text-2xs text-muted">{d.ok ? <>Top {d.rows.length} of {number(d.scanned)} matches · <b className="text-success">{d.tookMs} ms</b></> : <span className="text-warning">{d.error || 'search failed'}</span>}</div>}
        <div className="max-h-72 overflow-auto rounded-lg border border-border">
          {(d?.rows?.length ?? 0) === 0 ? (
            <div className="px-3 py-6 text-center text-2xs text-muted">{search.isPending ? 'Searching…' : 'Run a search to query the ClickHouse log store (event · siem · audit).'}</div>
          ) : (
            <table className="w-full text-2xs">
              <tbody>
                {d!.rows.map((r, i) => (
                  <tr key={i} className="border-t border-border-soft align-top first:border-0">
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-muted">{r.ts}</td>
                    <td className="px-2 py-1"><span className="rounded bg-brand/15 px-1 text-brand">{r.source}</span></td>
                    <td className="px-2 py-1 text-muted-light">{r.level}</td>
                    <td className="px-2 py-1 text-white">{r.message}{r.host && <span className="text-muted"> · {r.host}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Card>
  );
}
