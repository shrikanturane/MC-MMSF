'use client';

import { Fragment, useState } from 'react';
import { Card, ErrorState, LoadingState, Modal } from '@/components/ui';
import {
  useReports,
  useReportSources,
  useCreateReport,
  useUpdateReport,
  useDeleteReport,
  useRunReport,
  useReportRuns,
  downloadReport,
} from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import type { ReportItem, ReportSource } from '@/lib/types';

const RUN_STATUS_COLOR: Record<string, string> = { success: '#22c55e', failed: '#ef4444', running: '#f59e0b' };

const PROVIDERS = ['all', 'aws', 'azure', 'gcp', 'docker'];
const ENVS = ['all', 'production', 'staging', 'development', 'test', 'unknown'];
const SEVERITIES = ['', 'critical', 'high', 'medium', 'low'];
const FINDING_TYPES = ['', 'vulnerability', 'misconfiguration', 'threat'];

export function ReportsView() {
  const reports = useReports();
  const sources = useReportSources();
  const run = useRunReport();
  const [editing, setEditing] = useState<ReportItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<{ report: ReportItem; columns: string[]; rows: any[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [histId, setHistId] = useState<string | null>(null);

  if (reports.isLoading) return <LoadingState rows={6} />;
  if (reports.isError) return <ErrorState />;

  const srcLabel = (k: string) => sources.data?.find((s) => s.key === k)?.label ?? k;

  const doRun = async (r: ReportItem) => {
    setBusyId(r.id);
    try {
      const res = await run.mutateAsync(r.id);
      setPreview({ report: r, columns: res.columns, rows: res.rows });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-border bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">Custom Reports</div>
          <div className="text-2xs text-muted">Build reports over inventory, cost, security, compliance &amp; governance. Run, download CSV, or schedule by email.</div>
        </div>
        <button onClick={() => setAdding(true)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ New Report</button>
      </div>

      <Card title={`Reports (${reports.data?.length ?? 0})`} bodyClassName="p-0">
        {reports.data?.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card text-lg">📊</span>
            <div className="text-sm font-medium text-white">No reports yet</div>
            <div className="text-2xs text-muted">Click <b className="text-white">+ New Report</b> to build one from a data source, run it on demand or on a schedule, and export.</div>
          </div>
        ) : (
          <div className="divide-y divide-border-soft">
            {reports.data?.map((r) => (
              <div key={r.id}>
                <div className="group flex items-center gap-3 px-4 py-3 transition hover:bg-card-hover">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-base">📊</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-white">{r.name}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-2xs capitalize ${r.schedule === 'manual' ? 'bg-border/40 text-muted' : 'bg-brand/15 text-brand'}`}>{r.schedule === 'manual' ? 'on demand' : `🕑 ${r.schedule}`}</span>
                    </div>
                    <div className="mt-0.5 truncate text-2xs text-muted">{srcLabel(r.source)}{r.description ? ` · ${r.description}` : ''}</div>
                    <div className="text-2xs text-muted">{r.lastRunAt ? `Last run ${timeAgo(r.lastRunAt)} · ${r.lastRowCount} rows` : 'Never run'}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button onClick={() => doRun(r)} disabled={busyId === r.id} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{busyId === r.id ? 'Running…' : '▶ Run'}</button>
                    <button onClick={() => downloadReport(r.id, r.name)} title="Download" className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-brand hover:text-white">⤓</button>
                    <button onClick={() => setHistId(histId === r.id ? null : r.id)} className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-light hover:text-white">{histId === r.id ? 'Hide' : 'History'}</button>
                    <div className="flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
                      <button onClick={() => setEditing(r)} className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-light hover:text-white">Edit</button>
                      <DeleteBtn id={r.id} />
                    </div>
                  </div>
                </div>
                {histId === r.id && <div className="border-t border-border-soft bg-bg/40 px-4 py-3"><RunHistory reportId={r.id} /></div>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {(adding || editing) && <ReportModal report={editing} sources={sources.data ?? []} onClose={() => { setAdding(false); setEditing(null); }} />}
      {preview && <PreviewModal preview={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** Past runs of a report (manual + scheduled) — wired to GET /reports/:id/runs. */
function RunHistory({ reportId }: { reportId: string }) {
  const runs = useReportRuns(reportId);
  if (runs.isLoading) return <div className="text-2xs text-muted">Loading run history…</div>;
  const data = runs.data ?? [];
  if (data.length === 0) return <div className="text-2xs text-muted">No runs yet — click <b className="text-white">Run</b> or wait for the schedule.</div>;
  return (
    <div>
      <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">Run history ({data.length})</div>
      <div className="divide-y divide-border-soft rounded-lg border border-border">
        {data.map((run) => (
          <div key={run.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-2xs">
            <span className="flex items-center gap-2">
              <span className="rounded px-1.5 py-0.5 font-medium" style={{ background: `${RUN_STATUS_COLOR[run.status] ?? '#64748b'}22`, color: RUN_STATUS_COLOR[run.status] ?? '#64748b' }}>{run.status}</span>
              <span className="text-muted-light">{run.trigger}</span>
              {run.detail && <span className="text-muted">· {run.detail}</span>}
            </span>
            <span className="flex items-center gap-3 text-muted">
              <span className="text-white">{run.rowCount} rows</span>
              <span title={new Date(run.ts).toLocaleString()}>{timeAgo(run.ts)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DeleteBtn({ id }: { id: string }) {
  const del = useDeleteReport();
  return <button onClick={() => confirm('Delete this report?') && del.mutate(id)} className="text-2xs text-danger hover:underline">Delete</button>;
}

function ReportModal({ report, sources, onClose }: { report: ReportItem | null; sources: ReportSource[]; onClose: () => void }) {
  const create = useCreateReport();
  const update = useUpdateReport();
  const isEdit = !!report;
  const [f, setF] = useState<any>({
    name: report?.name ?? '',
    description: report?.description ?? '',
    source: report?.source ?? 'resources',
    format: report?.format ?? 'csv',
    schedule: report?.schedule ?? 'manual',
    recipients: report?.recipients ?? '',
    config: report?.config ?? {},
  });
  const [err, setErr] = useState<string | null>(null);
  const src = sources.find((s) => s.key === f.source);
  const setCfg = (k: string, v: string) => setF({ ...f, config: { ...f.config, [k]: v } });

  const save = async () => {
    setErr(null);
    if (!f.name.trim()) return setErr('Name is required');
    const body = { name: f.name, description: f.description, source: f.source, format: f.format, schedule: f.schedule, recipients: f.recipients, config: f.config };
    try {
      if (isEdit) await update.mutateAsync({ id: report!.id, ...body });
      else await create.mutateAsync(body);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal title={isEdit ? 'Edit Report' : 'New Report'} subtitle="Pick a data source, filter it, choose delivery" onClose={onClose}>
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}
        <Field label="Report name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inp} /></Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Data source">
            <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value, config: {} })} className={inp}>
              {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Format">
            <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })} className={inp}>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </Field>
        </div>

        {/* dynamic filters per source */}
        {src && src.filters.length > 0 && (
          <div className="rounded-lg border border-border bg-card/50 p-3">
            <div className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted">Filters</div>
            <div className="grid grid-cols-2 gap-3">
              {src.filters.includes('provider') && <FilterSelect label="Provider" value={f.config.provider ?? 'all'} options={PROVIDERS} onChange={(v) => setCfg('provider', v)} />}
              {src.filters.includes('environment') && <FilterSelect label="Environment" value={f.config.environment ?? 'all'} options={ENVS} onChange={(v) => setCfg('environment', v)} />}
              {src.filters.includes('severity') && <FilterSelect label="Severity" value={f.config.severity ?? ''} options={SEVERITIES} onChange={(v) => setCfg('severity', v)} />}
              {src.filters.includes('type') && f.source === 'security' && <FilterSelect label="Finding type" value={f.config.type ?? ''} options={FINDING_TYPES} onChange={(v) => setCfg('type', v)} />}
              {src.filters.includes('type') && f.source === 'resources' && <Field label="Resource type"><input value={f.config.type ?? ''} onChange={(e) => setCfg('type', e.target.value)} placeholder="compute, storage…" className={inp} /></Field>}
              {src.filters.includes('status') && <Field label="Status"><input value={f.config.status ?? ''} onChange={(e) => setCfg('status', e.target.value)} placeholder="running, open, failed…" className={inp} /></Field>}
              {src.filters.includes('standard') && <Field label="Standard"><input value={f.config.standard ?? ''} onChange={(e) => setCfg('standard', e.target.value)} placeholder="CIS, ISO 27001…" className={inp} /></Field>}
              {src.filters.includes('group') && <Field label="Scope / group"><input value={f.config.group ?? ''} onChange={(e) => setCfg('group', e.target.value)} placeholder="all groups (blank)" className={inp} /></Field>}
              {src.filters.includes('kind') && <FilterSelect label="Kind" value={f.config.kind ?? 'all'} options={['all', 'host', 'device', 'agent']} onChange={(v) => setCfg('kind', v)} />}
            </div>
          </div>
        )}
        {src && <div className="text-2xs text-muted">Columns: {src.columns.join(', ')}</div>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Schedule">
            <select value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })} className={inp}>
              <option value="manual">Manual</option>
              <option value="daily">Daily (email)</option>
              <option value="weekly">Weekly (email)</option>
            </select>
          </Field>
          {f.schedule !== 'manual' && <Field label="Email recipients"><input value={f.recipients} onChange={(e) => setF({ ...f, recipients: e.target.value })} placeholder="a@x.com, b@y.com" className={inp} /></Field>}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={save} disabled={create.isPending || update.isPending} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{isEdit ? 'Save' : 'Create report'}</button>
        </div>
      </div>
    </Modal>
  );
}

function PreviewModal({ preview, onClose }: { preview: { report: ReportItem; columns: string[]; rows: any[] }; onClose: () => void }) {
  const { report, columns, rows } = preview;
  return (
    <Modal title={report.name} subtitle={`${rows.length} rows`} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex justify-end">
          <button onClick={() => downloadReport(report.id, report.name)} className="rounded-lg bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft">⤓ Download CSV</button>
        </div>
        <div className="max-h-96 overflow-auto rounded-lg border border-border">
          <table className="w-full text-2xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left uppercase tracking-wide text-muted">
                {columns.map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, i) => (
                <tr key={i} className="border-b border-border-soft last:border-0">
                  {columns.map((c) => <td key={c} className="px-3 py-1.5 text-muted-light">{String(r[c] ?? '')}</td>)}
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={columns.length} className="px-3 py-6 text-center text-muted">No rows match.</td></tr>}
            </tbody>
          </table>
        </div>
        {rows.length > 200 && <div className="text-2xs text-muted">Showing first 200 of {rows.length} rows — download for the full set.</div>}
      </div>
    </Modal>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inp}>
        {options.map((o) => <option key={o} value={o}>{o === '' ? 'any' : o}</option>)}
      </select>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

const inp = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none';
