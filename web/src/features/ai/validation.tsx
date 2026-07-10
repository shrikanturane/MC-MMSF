'use client';

import { useState } from 'react';
import { Card, ErrorState, LoadingState, StatCard } from '@/components/ui';
import {
  useRunCiemEval, useRunCorrelationEval, useRunEvalTrial, useRunRcaEval,
  useSaveSuppressions, useSuppressions, useValidationSummary,
} from '@/lib/hooks';
import type { SuppressionWindowCfg, ValidationSummary } from '@/lib/types';

const STATUS_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  evidence: { label: '✓ evidence', bg: '#10b98122', fg: '#10b981' },
  ready: { label: '▶ ready to run', bg: '#3b82f622', fg: '#60a5fa' },
  manual: { label: '👤 manual protocol', bg: '#64748b22', fg: '#94a3b8' },
};

const fmtMetric = (m: unknown): string => {
  if (m === null || m === undefined) return '—';
  if (typeof m === 'string') return m;
  if (typeof m === 'number') return String(m);
  return JSON.stringify(m).slice(0, 140);
};

function SuiteRunners() {
  const trial = useRunEvalTrial();
  const rca = useRunRcaEval();
  const corr = useRunCorrelationEval();
  const ciem = useRunCiemEval();
  const btn = 'rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50';
  return (
    <div className="flex flex-wrap gap-2">
      <button
        className={btn}
        disabled={trial.isPending}
        title="Full anomaly battery: 30 seeded trials across compute/storage/database + threshold sweep (PR curve). Thesis 1.2/1.3/2.1/2.2/2.4/2.5/2.6."
        onClick={() => trial.mutate({ trials: 30, resourceTypes: ['compute', 'storage', 'database'], sweep: true })}
      >
        {trial.isPending ? 'Anomaly battery… (takes a few min)' : '🧪 Anomaly battery (30 trials + sweep)'}
      </button>
      <button className={btn} disabled={rca.isPending} title="15 seeded incidents with known causes → RCA top-k accuracy + precision@1. Thesis 5.1/5.4." onClick={() => rca.mutate(undefined)}>
        {rca.isPending ? 'RCA eval…' : '🔎 RCA eval (15 incidents)'}
      </button>
      <button className={btn} disabled={corr.isPending} title="Seeds a 3-provider incident + decoys → correlation recall. Thesis 5.3." onClick={() => corr.mutate(undefined)}>
        {corr.isPending ? 'Correlation eval…' : '🔗 Correlation eval'}
      </button>
      <button className={btn} disabled={ciem.isPending} title="Sandboxed labelled identities → entitlement-detection precision/recall + consistency. Thesis 6.3/6.4 (never touches live IAM)." onClick={() => ciem.mutate(undefined)}>
        {ciem.isPending ? 'CIEM eval…' : '🛡 CIEM eval (sandbox)'}
      </button>
    </div>
  );
}

function HeadlineStats({ s }: { s: ValidationSummary }) {
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard
        label="Anomaly precision (trials)"
        value={pct(s.anomaly?.aggregate?.precision?.mean ?? s.anomaly?.precision)}
        accent="#10b981"
        sub={s.anomaly?.aggregate?.precision ? `±${Math.round((s.anomaly.aggregate.precision.sd ?? 0) * 100)}% over ${s.anomaly.aggregate.precision.n} trials` : s.anomaly ? '1 trial' : 'run the battery'}
      />
      <StatCard
        label="Anomaly recall / MTTD"
        value={pct(s.anomaly?.aggregate?.recall?.mean ?? s.anomaly?.recall)}
        accent="#3b82f6"
        sub={s.anomaly?.mttdSeconds != null ? `MTTD ${Math.round((s.anomaly.mttdSeconds as number) / 60)} min` : '—'}
      />
      <StatCard label="RCA top-1 / top-3" value={s.rca ? `${pct(s.rca.topK.k1)} / ${pct(s.rca.topK.k3)}` : '—'} accent="#8b5cf6" sub={s.rca ? `${s.rca.incidents} seeded incidents, ${s.rca.meanDiagnosisMs}ms/diagnosis` : 'run RCA eval'} />
      <StatCard label="CIEM detection" value={s.ciem ? `${pct(s.ciem.precision)} P / ${pct(s.ciem.recall)} R` : '—'} accent="#f59e0b" sub={s.ciem ? s.ciem.verdict.slice(0, 40) : 'run CIEM eval (sandbox)'} />
    </div>
  );
}

function TestMap({ s }: { s: ValidationSummary }) {
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-panel text-2xs uppercase text-muted">
          <tr>
            <th className="px-2 py-1.5 w-16">Test</th>
            <th className="px-2 py-1.5">What it proves</th>
            <th className="px-2 py-1.5">Status</th>
            <th className="px-2 py-1.5">Latest evidence</th>
          </tr>
        </thead>
        <tbody>
          {s.map.map((t) => {
            const chip = STATUS_CHIP[t.status] ?? STATUS_CHIP.manual!;
            return (
              <tr key={t.id} className="border-t border-border/60 align-top">
                <td className="px-2 py-2 font-semibold text-white">{t.id}</td>
                <td className="px-2 py-2 text-muted-light">{t.name}</td>
                <td className="px-2 py-2"><span className="pill whitespace-nowrap" style={{ background: chip.bg, color: chip.fg }}>{chip.label}</span></td>
                <td className="max-w-[380px] px-2 py-2 text-2xs text-muted-light">{fmtMetric(t.metric)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PrCurve({ s }: { s: ValidationSummary }) {
  const pts = s.anomaly?.prCurve;
  if (!pts?.length) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-2xs font-semibold uppercase text-muted">Precision–recall vs z-threshold (2.6)</div>
      <div className="flex flex-wrap gap-2">
        {pts.map((p) => (
          <div key={p.threshold} className="rounded-lg border border-border bg-card px-3 py-1.5 text-2xs text-muted-light">
            <span className="font-semibold text-white">z ≥ {p.threshold}</span>
            {' · '}P {p.precision ?? '—'} · R {p.recall ?? '—'} · FP {p.fpRate ?? '—'}
          </div>
        ))}
      </div>
    </div>
  );
}

function SuppressionEditor() {
  const { data } = useSuppressions();
  const save = useSaveSuppressions();
  const [draft, setDraft] = useState<SuppressionWindowCfg | null>(null);
  const windows = data ?? [];

  const add = () =>
    setDraft({ id: `w-${windows.length + 1}`, name: '', match: '', metric: '', days: [], startHour: 1, endHour: 4, enabled: true });
  const commit = () => {
    if (!draft || !draft.name.trim()) return;
    save.mutate([...windows, draft]);
    setDraft(null);
  };
  const remove = (id: string) => save.mutate(windows.filter((w) => w.id !== id));

  return (
    <Card title="Suppression Windows (declared legitimate load — 2.4)">
      <p className="mb-2 text-2xs text-muted">
        Declare scheduled batch jobs / backups here: a sustained spike inside a window is expected load, not an anomaly. Hours are UTC.
      </p>
      {windows.length === 0 && !draft && <p className="text-2xs text-muted">No windows declared.</p>}
      <div className="grid gap-1.5">
        {windows.map((w) => (
          <div key={w.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-2xs">
            <span className="font-medium text-white">{w.name}</span>
            <span className="text-muted-light">match “{w.match || 'any'}” · metric {w.metric || 'any'} · {String(w.startHour).padStart(2, '0')}–{String(w.endHour).padStart(2, '0')} UTC{w.days.length ? ` · days ${w.days.join(',')}` : ' · daily'}</span>
            <div className="flex-1" />
            <button onClick={() => remove(w.id)} className="text-red-400 hover:text-red-300">remove</button>
          </div>
        ))}
        {draft ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/40 bg-card px-3 py-2 text-2xs">
            <input placeholder="name (e.g. nightly ETL)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-36 rounded border border-border bg-panel px-2 py-1 text-white" />
            <input placeholder="resource match" value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value })} className="w-32 rounded border border-border bg-panel px-2 py-1 text-white" />
            <select value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value })} className="rounded border border-border bg-panel px-2 py-1 text-muted-light">
              <option value="">any metric</option>
              <option value="cpu">cpu</option>
              <option value="net">net</option>
              <option value="disk">disk</option>
              <option value="cost">cost</option>
            </select>
            <label className="text-muted">from <input type="number" min={0} max={23} value={draft.startHour} onChange={(e) => setDraft({ ...draft, startHour: Number(e.target.value) })} className="w-14 rounded border border-border bg-panel px-1 py-1 text-white" /></label>
            <label className="text-muted">to <input type="number" min={1} max={24} value={draft.endHour} onChange={(e) => setDraft({ ...draft, endHour: Number(e.target.value) })} className="w-14 rounded border border-border bg-panel px-1 py-1 text-white" /></label>
            <button onClick={commit} disabled={save.isPending || !draft.name.trim()} className="rounded bg-brand px-2.5 py-1 font-medium text-white disabled:opacity-50">Save</button>
            <button onClick={() => setDraft(null)} className="text-muted hover:text-white">cancel</button>
          </div>
        ) : (
          <button onClick={add} className="w-fit rounded-md border border-border bg-card px-3 py-1 text-2xs font-medium text-muted-light hover:text-white">＋ Add window</button>
        )}
      </div>
    </Card>
  );
}

export function ValidationPanel() {
  const summary = useValidationSummary();
  if (summary.isLoading) return <LoadingState rows={6} />;
  if (summary.isError) return <ErrorState />;
  const s = summary.data!;

  return (
    <div className="grid gap-4">
      <Card title="Validation Suites (thesis evidence generators)">
        <p className="mb-3 text-2xs text-muted">
          Each suite runs a labelled, seeded, deterministic control trial against the REAL pipeline and persists its report.
          Sandboxed artifacts are cleaned up automatically; live data is never modified.
        </p>
        <SuiteRunners />
        <div className="mt-4">
          <HeadlineStats s={s} />
        </div>
        <PrCurve s={s} />
        {s.anomaly?.mttdByType && (
          <div className="mt-3 flex flex-wrap gap-2 text-2xs text-muted-light">
            <span className="font-semibold uppercase text-muted">MTTD by type (2.5):</span>
            {Object.entries(s.anomaly.mttdByType).map(([t, v]) => (
              <span key={t} className="rounded bg-card px-2 py-0.5">{t}: {v != null ? `${Math.round((v as number) / 60)} min` : '—'}</span>
            ))}
            {s.anomaly?.suppressionCase && <span className="rounded bg-card px-2 py-0.5">2.4: {String(s.anomaly.suppressionCase).split('—')[0]}</span>}
          </div>
        )}
      </Card>

      <Card title="Thesis Test Matrix — live evidence">
        <TestMap s={s} />
      </Card>

      <SuppressionEditor />
    </div>
  );
}
