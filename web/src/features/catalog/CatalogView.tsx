'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import {
  useCatalog, useProvisionJobs, usePlanProvision, useApplyProvision, useDestroyProvision, useConnections,
  type CatalogTemplateMeta, type ProvisionJob,
} from '@/lib/hooks';

const CLOUD_BADGE: Record<string, string> = { demo: 'bg-slate-500/20 text-slate-300', aws: 'bg-amber-500/15 text-amber-300', azure: 'bg-sky-500/15 text-sky-300', gcp: 'bg-emerald-500/15 text-emerald-300' };
const STATUS_BADGE: Record<string, string> = {
  planned: 'bg-slate-500/20 text-slate-300', plan_failed: 'bg-danger/15 text-danger', pending_apply: 'bg-brand/15 text-brand',
  applying: 'bg-amber-500/15 text-amber-300', applied: 'bg-emerald-500/15 text-emerald-300', apply_failed: 'bg-danger/15 text-danger', destroyed: 'bg-border/50 text-muted',
};

export function CatalogView() {
  const { data: templates } = useCatalog();
  const [picked, setPicked] = useState<CatalogTemplateMeta | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-white">Service Catalog</h1>
        <p className="text-2xs text-muted">Provision cloud resources from reusable Terraform templates — one engine across AWS, Azure & GCP. Plan first, then apply. Runs in the isolated <span className="font-mono text-white">tf-runner</span> worker.</p>
      </div>

      {/* Template catalog */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(templates ?? []).map((t) => (
          <button key={t.key} onClick={() => setPicked(t)} className={`rounded-xl border p-3 text-left transition ${picked?.key === t.key ? 'border-brand bg-brand/10' : 'border-border bg-card/60 hover:border-brand/40'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-white">{t.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${CLOUD_BADGE[t.cloud] ?? 'bg-border/50 text-muted'}`}>{t.cloud}</span>
            </div>
            <p className="mt-1 text-2xs text-muted">{t.description}</p>
          </button>
        ))}
        {(templates ?? []).length === 0 && <div className="col-span-full rounded-lg border border-border bg-bg/40 px-3 py-6 text-center text-2xs text-muted">No catalog templates.</div>}
      </div>

      {picked && <ProvisionForm template={picked} onClose={() => setPicked(null)} />}

      <JobsTable />
    </div>
  );
}

function ProvisionForm({ template, onClose }: { template: CatalogTemplateMeta; onClose: () => void }) {
  const conns = useConnections();
  const plan = usePlanProvision();
  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries(template.inputs.map((i) => [i.key, String(i.default ?? '')])));
  const [connectionId, setConnectionId] = useState('');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const candidates = (conns.data ?? []).filter((c) => c.provider === template.cloud);
  const needConn = template.cloud !== 'demo';

  const submit = async () => {
    setErr(null);
    if (needConn && !connectionId) { setErr(`Select a ${template.cloud.toUpperCase()} connection.`); return; }
    try { await plan.mutateAsync({ template: template.key, inputs, connectionId: connectionId || undefined, title: title || undefined }); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <Card title={`Provision — ${template.name}`} className="col-span-12" bodyClassName="p-3 space-y-3" action={<button onClick={onClose} className="text-2xs text-muted hover:text-white">✕ close</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-2xs text-muted">Name / label (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={template.name} className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </label>
        {needConn && (
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-2xs text-muted">{template.cloud.toUpperCase()} connection <span className="text-danger">*</span></span>
            <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none">
              <option value="">— Select a connection —</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.accountRef || c.provider})</option>)}
            </select>
            {candidates.length === 0 && <span className="mt-1 block text-2xs text-amber-300">No {template.cloud.toUpperCase()} connections — add one in Settings → Cloud Connections.</span>}
          </label>
        )}
        {template.inputs.map((i) => (
          <label key={i.key} className="block">
            <span className="mb-1 block text-2xs text-muted">{i.label}</span>
            <input type={i.type === 'number' ? 'number' : 'text'} value={inputs[i.key] ?? ''} onChange={(e) => setInputs({ ...inputs, [i.key]: e.target.value })} className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white focus:border-brand focus:outline-none" />
            {i.help && <span className="mt-0.5 block text-[10px] text-muted">{i.help}</span>}
          </label>
        ))}
      </div>
      {err && <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={plan.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{plan.isPending ? 'Planning…' : '① Plan'}</button>
        <span className="text-2xs text-muted">Plan is read-only — it shows what would be created. Apply (after review) actually provisions.</span>
      </div>
    </Card>
  );
}

function JobsTable() {
  const { data: jobs } = useProvisionJobs();
  const apply = useApplyProvision();
  const destroy = useDestroyProvision();
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  const doApply = async (id: string) => { setErr(null); try { await apply.mutateAsync(id); } catch (e) { setErr({ id, text: (e as Error).message }); } };

  return (
    <Card title="Provisioning runs" className="col-span-12" bodyClassName="p-0">
      <div className="border-b border-border-soft px-4 py-2 text-2xs text-muted">Plan shows a rough monthly cost estimate. With <b className="text-white">maker-checker</b> on, whoever planned a run can&apos;t apply it — a different user must. A successful cloud apply re-syncs that connection so the new resource appears in <b className="text-white">Cloud Inventory</b>.</div>
      <div className="divide-y divide-border-soft">
        {(jobs ?? []).length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">No provisioning runs yet — pick a template above and Plan.</div>}
        {(jobs ?? []).map((j) => (
          <div key={j.id} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button onClick={() => setOpen(open === j.id ? null : j.id)} className="flex items-center gap-2 text-left">
                <span className="text-muted">{open === j.id ? '▾' : '▸'}</span>
                <span>
                  <span className="block text-sm font-medium text-white">{j.title}</span>
                  <span className="block text-2xs text-muted">{j.cloud} · {j.template} · {new Date(j.createdAt).toLocaleString()}{j.requestedBy && ` · by ${j.requestedBy}`}{j.approvedBy && ` · applied by ${j.approvedBy}`}</span>
                </span>
              </button>
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-2xs ${j.estCostMonthly > 0 ? 'bg-amber-500/15 text-amber-300' : 'bg-border/40 text-muted'}`} title={j.costNote}>≈ ${j.estCostMonthly}/mo</span>
                <span className={`rounded px-1.5 py-0.5 text-2xs ${STATUS_BADGE[j.status] ?? 'bg-border/50 text-muted'}`}>{j.status.replace(/_/g, ' ')}</span>
                {j.status === 'pending_apply' && <button onClick={() => doApply(j.id)} disabled={apply.isPending} className="rounded-md bg-emerald-600 px-2.5 py-1 text-2xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">② Apply</button>}
                {j.status === 'applied' && <button onClick={() => confirm(`Destroy the resources from "${j.title}"?`) && destroy.mutate(j.id)} disabled={destroy.isPending} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-danger hover:bg-danger/10">Destroy</button>}
              </div>
            </div>
            {err?.id === j.id && <div className="mt-1.5 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-2xs text-danger">{err.text}</div>}
            {open === j.id && (
              <div className="mt-2 space-y-2">
                {j.costNote && <div className="text-2xs text-muted">💰 Est. cost: <b className="text-white">≈ ${j.estCostMonthly}/mo</b> — {j.costNote}</div>}
                {Object.keys(j.outputs ?? {}).length > 0 && (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.06] p-2 text-2xs">
                    <div className="mb-1 font-semibold text-emerald-300">Outputs</div>
                    {Object.entries(j.outputs).map(([k, v]) => <div key={k} className="font-mono text-white">{k} = {JSON.stringify((v as any)?.value ?? v)}</div>)}
                  </div>
                )}
                {j.planLog && <LogBlock label="Plan" log={j.planLog} />}
                {j.applyLog && <LogBlock label="Apply / Destroy" log={j.applyLog} />}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function LogBlock({ label, log }: { label: string; log: string }) {
  return (
    <div className="rounded-md border border-border bg-bg">
      <div className="border-b border-border-soft px-2 py-1 text-2xs font-semibold text-muted">{label}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10px] leading-relaxed text-muted-light">{log}</pre>
    </div>
  );
}
