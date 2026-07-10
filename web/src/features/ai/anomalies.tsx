'use client';

import { useState } from 'react';
import { Card, ErrorState, LoadingState, StatCard } from '@/components/ui';
import { useAnomalies, useAnomalyQuality, useReviewAnomaly, useRunAnomalyScan, useRunEvalTrial } from '@/lib/hooks';
import type { AnomalyDetectionRow, AnomalyTrialReport } from '@/lib/types';

const SEV_COLOR: Record<string, string> = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#64748b' };
// Statistical anomalies (blue) vs plain rule breaches (amber) — never conflated.
const DETECTOR_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  cost: { label: '📈 cost anomaly', bg: '#3b82f622', fg: '#60a5fa' },
  behaviour: { label: '🫀 behaviour anomaly', bg: '#3b82f622', fg: '#60a5fa' },
  threshold: { label: '📏 threshold', bg: '#f59e0b22', fg: '#f59e0b' },
};

function DetectorChip({ type }: { type: string }) {
  const c = DETECTOR_CHIP[type] ?? DETECTOR_CHIP.threshold!;
  return <span className="pill whitespace-nowrap" style={{ background: c.bg, color: c.fg }}>{c.label}</span>;
}

function ReviewButtons({ row }: { row: AnomalyDetectionRow }) {
  const review = useReviewAnomaly();
  if (row.isConfirmed === true) return <span className="text-2xs text-emerald-400">✓ confirmed{row.confirmedBy ? ` · ${row.confirmedBy}` : ''}</span>;
  if (row.isConfirmed === false) return <span className="text-2xs text-muted">✗ dismissed (false positive)</span>;
  return (
    <div className="flex gap-1.5">
      <button
        onClick={() => review.mutate({ id: row.id, verdict: 'confirm' })}
        disabled={review.isPending}
        title="Confirm as a real anomaly — this also releases the email/WhatsApp notification (human approval gate)"
        className="rounded-md bg-emerald-600/20 px-2.5 py-1 text-2xs font-medium text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50"
      >
        ✓ Confirm
      </button>
      <button
        onClick={() => review.mutate({ id: row.id, verdict: 'dismiss' })}
        disabled={review.isPending}
        title="Dismiss as a false positive — feeds the precision metric and resolves the in-app alert"
        className="rounded-md bg-red-600/15 px-2.5 py-1 text-2xs font-medium text-red-400 hover:bg-red-600/25 disabled:opacity-50"
      >
        ✗ Dismiss
      </button>
    </div>
  );
}

function QualityPanel() {
  const { data } = useAnomalyQuality();
  const pctOrDash = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  const live = data?.live;
  const ev = data?.eval;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Precision (live labels)" value={pctOrDash(live?.precision)} accent="#10b981" sub={live ? `${live.confirmed}✓ / ${live.dismissed}✗ of ${live.reviewed} reviewed` : 'no reviews yet'} />
      <StatCard label="FP share (live labels)" value={pctOrDash(live?.fpShare)} accent="#ef4444" sub={`${live?.unreviewed ?? 0} awaiting review`} />
      <StatCard label="Recall (eval trial)" value={pctOrDash(ev?.recall)} accent="#3b82f6" sub={ev ? `trial ${new Date(ev.ranAt).toLocaleString()}` : 'run a control trial'} />
      <StatCard label="MTTD (eval trial)" value={ev?.mttdSeconds != null ? `${Math.round(ev.mttdSeconds / 60)} min` : '—'} accent="#8b5cf6" sub={ev ? `FP rate ${pctOrDash(ev.fpRate)}` : 'mean time to detect'} />
    </div>
  );
}

function TrialResult({ report }: { report: AnomalyTrialReport }) {
  const pass = report.pilotCase.startsWith('PASS');
  return (
    <div className="mt-3 grid gap-2">
      <div className={`rounded-lg border p-3 text-xs ${pass ? 'border-emerald-700/40 bg-emerald-600/10 text-emerald-300' : 'border-red-700/40 bg-red-600/10 text-red-300'}`}>
        <span className="font-semibold">Two-VM pilot case:</span> {report.pilotCase}
      </div>
      <div className="flex flex-wrap gap-3 text-2xs text-muted-light">
        <span>precision <b className="text-white">{report.precision ?? '—'}</b></span>
        <span>recall <b className="text-white">{report.recall ?? '—'}</b></span>
        <span>FP rate <b className="text-white">{report.fpRate ?? '—'}</b></span>
        <span>MTTD <b className="text-white">{report.mttdSeconds != null ? `${Math.round(report.mttdSeconds / 60)} min` : '—'}</b></span>
        <span>TP {report.counts.tp} · FP {report.counts.fp} · TN {report.counts.tn} · FN {report.counts.fn}</span>
        <span>seed {report.seed}</span>
        <span>{report.chUsed ? 'via ClickHouse pipeline' : 'in-memory series (ClickHouse down)'}</span>
      </div>
      <div className="grid gap-1">
        {report.cases.map((c) => (
          <div key={c.resourceId} className="flex items-center gap-2 text-2xs">
            <span className={`w-8 font-semibold ${c.outcome === 'TP' || c.outcome === 'TN' ? 'text-emerald-400' : 'text-red-400'}`}>{c.outcome}</span>
            <span className="text-white">{c.resourceName}</span>
            <span className="text-muted">({c.label})</span>
            <span className="truncate text-muted-light">{c.detail}</span>
            {c.detectSeconds != null && <span className="whitespace-nowrap text-muted">detected in {Math.round(c.detectSeconds / 60)} min</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AnomalyFeedPanel() {
  const [detector, setDetector] = useState('');
  const [status, setStatus] = useState('');
  const anomalies = useAnomalies({ detector: detector || undefined, status: status || undefined });
  const scan = useRunAnomalyScan();

  if (anomalies.isLoading) return <LoadingState rows={5} />;
  if (anomalies.isError) return <ErrorState />;
  const rows = anomalies.data ?? [];

  return (
    <Card title="Anomaly Feed">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={detector} onChange={(e) => setDetector(e.target.value)} className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-light">
          <option value="">All detectors</option>
          <option value="cost">Cost anomaly</option>
          <option value="behaviour">Behaviour anomaly</option>
          <option value="threshold">Threshold breach</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-light">
          <option value="">All statuses</option>
          <option value="unreviewed">Unreviewed</option>
          <option value="confirmed">Confirmed</option>
          <option value="dismissed">Dismissed (FP)</option>
        </select>
        <div className="flex-1" />
        <button onClick={() => scan.mutate()} disabled={scan.isPending} className="rounded-md border border-border bg-card px-3 py-1 text-2xs font-medium text-muted-light hover:text-white disabled:opacity-50">
          {scan.isPending ? 'Scanning…' : '🔍 Scan now'}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-2xs text-muted">No detections{status || detector ? ' matching the filter' : ' yet — the engine scans every few minutes'}.</p>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-panel text-2xs uppercase text-muted">
              <tr>
                <th className="px-2 py-1.5">Resource</th>
                <th className="px-2 py-1.5">Signal</th>
                <th className="px-2 py-1.5">Severity</th>
                <th className="px-2 py-1.5">Score</th>
                <th className="px-2 py-1.5">Baseline</th>
                <th className="px-2 py-1.5">Reason</th>
                <th className="px-2 py-1.5">When</th>
                <th className="px-2 py-1.5">Review</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/60 align-top">
                  <td className="px-2 py-2">
                    <div className="font-medium text-white">{r.resourceName}</div>
                    <div className="text-2xs text-muted">{r.provider} · {r.metric}</div>
                  </td>
                  <td className="px-2 py-2"><DetectorChip type={r.detectorType} /></td>
                  <td className="px-2 py-2"><span className="pill" style={{ background: `${SEV_COLOR[r.severity]}22`, color: SEV_COLOR[r.severity] }}>{r.severity}</span></td>
                  <td className="px-2 py-2 text-muted-light">{r.score}</td>
                  <td className="px-2 py-2 text-muted-light">{r.baseline}</td>
                  <td className="max-w-[340px] px-2 py-2 text-muted-light">{r.reason}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-2xs text-muted">{new Date(r.detectedAt).toLocaleString()}</td>
                  <td className="px-2 py-2"><ReviewButtons row={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function AnomalyQualityCard() {
  const trial = useRunEvalTrial();
  return (
    <Card title="Detection Quality (precision / recall / FP-rate / MTTD)">
      <QualityPanel />
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-2xs text-muted">
          Precision &amp; FP share come from your confirm/dismiss labels. Recall &amp; MTTD need ground truth — run a labelled
          control trial: it provisions synthetic twin VMs (one normal, one anomalous), injects a known 14-day series, and scores the detectors.
        </p>
        <button
          onClick={() => trial.mutate(undefined)}
          disabled={trial.isPending}
          className="whitespace-nowrap rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50"
        >
          {trial.isPending ? 'Running trial…' : '🧪 Run control trial'}
        </button>
      </div>
      {trial.data && <TrialResult report={trial.data} />}
      {trial.isError && <p className="mt-2 text-2xs text-red-400">Trial failed — check the API logs (admin only).</p>}
    </Card>
  );
}

/** The AI Engine → Anomalies tab: quality on top, feed below. */
export function AnomaliesPanel() {
  return (
    <div className="grid gap-4">
      <AnomalyQualityCard />
      <AnomalyFeedPanel />
    </div>
  );
}
