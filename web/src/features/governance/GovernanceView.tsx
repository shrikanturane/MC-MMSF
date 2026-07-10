'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Board } from '@/features/board/Board';
import { Modal } from '@/components/ui';
import { useAuthUser } from '@/lib/auth';
import { usePolicyEnvironments, useEvaluatePolicies, usePolicyViolations, usePolicies } from '@/lib/hooks';
import { number } from '@/lib/format';
import type { BoardPanel } from '@/lib/types';

type Drill = 'compliance' | 'violations' | 'policies' | 'resources';

// Every governance panel is now a resizable widget on one customizable board (saved layout).
const SEED: BoardPanel[] = [
  { i: 'env', kind: 'environments', title: 'Environments', x: 0, y: 0, w: 12, h: 5 },
  { i: 'comp', kind: 'compliance', title: 'Compliance Overview', x: 0, y: 5, w: 12, h: 7 },
  { i: 'pol', kind: 'policies', title: 'Policies', x: 0, y: 12, w: 12, h: 9 },
];

export function GovernanceView() {
  const { data: me } = useAuthUser();
  const envs = usePolicyEnvironments();
  const evaluate = useEvaluatePolicies();
  const [drill, setDrill] = useState<Drill | null>(null);
  const t = envs.data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-border bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">Policy &amp; Environment Governance</div>
          <div className="text-2xs text-muted">Classify resources by environment and enforce guardrails. Every panel is a resizable widget — drag, resize, add/remove. Saved automatically.</div>
        </div>
        {me?.role !== 'viewer' && (
          <button onClick={() => evaluate.mutate()} disabled={evaluate.isPending} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white disabled:opacity-50">
            {evaluate.isPending ? 'Evaluating…' : 'Evaluate now'}
          </button>
        )}
      </div>

      {/* Posture KPIs — click to drill into the data */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Compliance" value={`${t?.compliancePct ?? 100}%`} color={(t?.compliancePct ?? 100) >= 80 ? '#22c55e' : (t?.compliancePct ?? 100) >= 50 ? '#f59e0b' : '#ef4444'} onClick={() => setDrill('compliance')} />
        <Kpi label="Violations" value={number(t?.violations ?? 0)} color={(t?.violations ?? 0) > 0 ? '#ef4444' : '#22c55e'} onClick={() => setDrill('violations')} />
        <Kpi label="Active Policies" value={`${t?.enabledPolicies ?? 0}/${t?.policies ?? 0}`} color="#3b82f6" onClick={() => setDrill('policies')} />
        <Kpi label="Resources" value={number(t?.resources ?? 0)} color="#a855f7" onClick={() => setDrill('resources')} />
      </div>

      <Board boardKey="governance" seed={SEED} />

      {drill && <DrillModal drill={drill} totals={t} environments={envs.data?.environments ?? []} onClose={() => setDrill(null)} />}
    </div>
  );
}

function Kpi({ label, value, color, onClick }: { label: string; value: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={`View ${label}`} className="group rounded-xl border border-border bg-card/60 px-4 py-3 text-left transition hover:border-brand/50 hover:bg-card-hover">
      <div className="text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="flex items-center gap-1 text-2xs text-muted">{label}<span className="opacity-0 transition group-hover:opacity-100">↗</span></div>
    </button>
  );
}

const TITLES: Record<Drill, string> = { compliance: 'Compliance by environment', violations: 'All policy violations', policies: 'Policies', resources: 'Resources by environment' };

function DrillModal({ drill, totals, environments, onClose }: { drill: Drill; totals?: { compliancePct?: number; violations?: number; resources?: number }; environments: { env: string; resources: number; violations: number }[]; onClose: () => void }) {
  const violations = usePolicyViolations();
  const policies = usePolicies();
  const policyName = (id: string) => policies.data?.find((p) => p.id === id)?.name ?? 'Policy';

  return (
    <Modal wide onClose={onClose} title={TITLES[drill]}>
      {drill === 'violations' && (
        violations.isLoading ? <Loading /> : !violations.data?.length ? <Ok>No policy violations across any environment.</Ok> : (
          <Scroll>
            <Table head={['Environment', 'Resource', 'Provider', 'Policy', 'Detail']}>
              {[...violations.data].sort((a, b) => a.environment.localeCompare(b.environment)).map((v) => (
                <tr key={v.id} className="border-b border-border-soft align-top">
                  <td className="py-1.5 pr-3 capitalize text-muted-light">{v.environment}</td>
                  <td className="py-1.5 pr-3 text-white">{v.resourceName}</td>
                  <td className="py-1.5 pr-3 uppercase text-muted">{v.provider}</td>
                  <td className="py-1.5 pr-3 text-muted-light">{policyName(v.policyId)}</td>
                  <td className="py-1.5 pr-3 text-muted">{v.detail ?? '—'}</td>
                </tr>
              ))}
            </Table>
          </Scroll>
        )
      )}

      {drill === 'policies' && (
        policies.isLoading ? <Loading /> : (
          <Scroll>
            <Table head={['Policy', 'Category', 'Effect', 'Scope', 'Status']}>
              {(policies.data ?? []).map((p) => (
                <tr key={p.id} className="border-b border-border-soft align-top">
                  <td className="py-1.5 pr-3 text-white">{p.name}</td>
                  <td className="py-1.5 pr-3 capitalize text-muted-light">{(p as any).category ?? '—'}</td>
                  <td className="py-1.5 pr-3 uppercase text-muted">{(p as any).effect ?? '—'}</td>
                  <td className="py-1.5 pr-3 capitalize text-muted">{(p as any).scopeEnv ?? 'all'}</td>
                  <td className="py-1.5 pr-3">{(p as any).enabled ? <span className="text-success">active</span> : <span className="text-muted">paused</span>}</td>
                </tr>
              ))}
            </Table>
          </Scroll>
        )
      )}

      {(drill === 'compliance' || drill === 'resources') && (
        <Scroll>
          {drill === 'compliance' && <div className="mb-2 text-2xs text-muted">Overall compliance: <span className="font-semibold text-white">{totals?.compliancePct ?? 100}%</span> · {number(totals?.violations ?? 0)} violations across {number(totals?.resources ?? 0)} resources.</div>}
          <Table head={drill === 'compliance' ? ['Environment', 'Resources', 'Violations', 'Status'] : ['Environment', 'Resources', 'Violations']}>
            {environments.map((e) => (
              <tr key={e.env} className="border-b border-border-soft">
                <td className="py-1.5 pr-3 capitalize text-white">{e.env}</td>
                <td className="py-1.5 pr-3 text-muted-light">{number(e.resources)}</td>
                <td className={`py-1.5 pr-3 ${e.violations > 0 ? 'text-danger' : 'text-success'}`}>{e.violations}</td>
                {drill === 'compliance' && <td className="py-1.5 pr-3">{e.violations === 0 ? <span className="text-success">compliant</span> : <span className="text-danger">{e.resources ? Math.max(0, Math.round((1 - Math.min(e.violations, e.resources) / e.resources) * 100)) : 0}% clean</span>}</td>}
              </tr>
            ))}
          </Table>
          <Link href="/inventory" onClick={onClose} className="mt-2 inline-block text-2xs text-brand hover:underline">Open full Inventory ↗</Link>
        </Scroll>
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
