'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Card, Modal } from '@/components/ui';
import { useAuthUser } from '@/lib/auth';
import {
  usePolicies,
  usePolicyEnvironments,
  usePolicyViolations,
  useCreatePolicy,
  useUpdatePolicy,
  useDeletePolicy,
} from '@/lib/hooks';
import { number } from '@/lib/format';
import type { Policy } from '@/lib/types';

const ENV_COLORS: Record<string, string> = {
  production: '#ef4444', staging: '#f59e0b', development: '#3b82f6', test: '#a855f7', unknown: '#64748b',
};
const CATEGORY_ICON: Record<string, string> = {
  security: '🛡', cost: '💰', tagging: '🏷', compliance: '📋', access: '🔑', data: '🔒', network: '🌐', operations: '⚙',
};
const RULE_LABELS: Record<string, string> = {
  require_tag: 'Require tag', required_tag_value: 'Require tag value', no_untagged: 'No untagged resources',
  no_public_ip: 'No public IP', allowed_regions: 'Allowed regions only', max_monthly_cost: 'Max monthly cost',
};
const ENVS = ['all', 'production', 'staging', 'development', 'test', 'unknown'];
const RULES = ['require_tag', 'required_tag_value', 'no_untagged', 'no_public_ip', 'allowed_regions', 'max_monthly_cost'];
const inp = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none';

function ruleSummary(p: Policy): string {
  const c = p.ruleConfig as any;
  switch (p.ruleKind) {
    case 'require_tag': return `must have tag "${c.tag ?? 'Owner'}"`;
    case 'required_tag_value': return `tag "${c.tag}" = "${c.value}"`;
    case 'no_untagged': return 'must have ≥1 tag';
    case 'no_public_ip': return 'must not expose a public IP';
    case 'allowed_regions': return `region ∈ [${(c.regions ?? []).join(', ')}]`;
    case 'max_monthly_cost': return `cost ≤ ${c.amount}`;
    default: return p.ruleKind;
  }
}

/** Card on its own page; bare inside a board cell (the cell supplies the frame). */
function Frame({ bare, title, action, bodyClassName, children }: { bare?: boolean; title: string; action?: ReactNode; bodyClassName?: string; children: ReactNode }) {
  if (bare) {
    return (
      <div className="flex h-full flex-col">
        {action && <div className="mb-2 flex flex-wrap items-center justify-end gap-2">{action}</div>}
        <div className={`min-h-0 flex-1 ${bodyClassName ?? ''}`}>{children}</div>
      </div>
    );
  }
  return <Card title={title} action={action} bodyClassName={bodyClassName}>{children}</Card>;
}

// ───────────────────────── Environments ─────────────────────────
export function EnvironmentsPanel({ bare = false }: { bare?: boolean }) {
  const envs = usePolicyEnvironments();
  const violations = usePolicyViolations();
  const policies = usePolicies();
  const [openEnv, setOpenEnv] = useState<string | null>(null);

  const policyName = (id: string) => policies.data?.find((p) => p.id === id)?.name ?? 'Policy';
  const envViolations = openEnv ? (violations.data ?? []).filter((v) => v.environment === openEnv) : [];

  return (
    <Frame bare={bare} title="Environments">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {envs.data?.environments.map((e) => (
          <button key={e.env} onClick={() => setOpenEnv(e.env)} title={`View ${e.env} violations`} className="group rounded-xl border border-border bg-card/60 p-3 text-left transition hover:border-brand/50 hover:bg-card-hover">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: ENV_COLORS[e.env] }} />
              <span className="text-2xs font-semibold capitalize text-white">{e.env}</span>
              <span className="ml-auto text-2xs text-muted opacity-0 transition group-hover:opacity-100">↗</span>
            </div>
            <div className="text-lg font-semibold text-white">{number(e.resources)}</div>
            <div className="text-2xs text-muted">resources</div>
            <div className={`mt-1 text-2xs ${e.violations > 0 ? 'text-danger' : 'text-success'}`}>{e.violations} violation{e.violations === 1 ? '' : 's'}</div>
          </button>
        ))}
      </div>

      {openEnv && (
        <Modal wide onClose={() => setOpenEnv(null)} title={`${openEnv} — ${envViolations.length} violation${envViolations.length === 1 ? '' : 's'}`}>
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-2xs text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: ENV_COLORS[openEnv] }} />
              <span className="capitalize text-white">{openEnv}</span> environment
            </span>
            <Link href={`/inventory?env=${encodeURIComponent(openEnv)}`} className="text-2xs text-brand hover:underline">View resources ↗</Link>
          </div>
          {violations.isLoading ? (
            <div className="py-6 text-center text-2xs text-muted">Loading violations…</div>
          ) : !envViolations.length ? (
            <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-4 text-center text-2xs text-success">✓ No policy violations in {openEnv}.</div>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-left text-2xs">
                <thead className="sticky top-0 bg-panel text-muted">
                  <tr className="border-b border-border">
                    <th className="py-1.5 pr-3 font-medium">Resource</th>
                    <th className="py-1.5 pr-3 font-medium">Provider</th>
                    <th className="py-1.5 pr-3 font-medium">Policy</th>
                    <th className="py-1.5 pr-3 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {envViolations.map((v) => (
                    <tr key={v.id} className="border-b border-border-soft align-top">
                      <td className="py-1.5 pr-3 text-white">{v.resourceName}</td>
                      <td className="py-1.5 pr-3 uppercase text-muted">{v.provider}</td>
                      <td className="py-1.5 pr-3 text-muted-light">{policyName(v.policyId)}</td>
                      <td className="py-1.5 pr-3 text-muted">{v.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </Frame>
  );
}

// ───────────────────────── Policies ─────────────────────────
export function PoliciesPanel({ bare = false }: { bare?: boolean }) {
  const { data: me } = useAuthUser();
  const isAdmin = me?.role === 'admin';
  const policies = usePolicies();
  const update = useUpdatePolicy();
  const [editing, setEditing] = useState<Policy | null>(null);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<Policy | null>(null);

  return (
    <Frame
      bare={bare}
      title={`Policies (${policies.data?.length ?? 0})`}
      bodyClassName="p-0"
      action={isAdmin ? <button onClick={() => setAdding(true)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ Add Policy</button> : undefined}
    >
      {policies.data?.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card text-lg">📜</span>
          <div className="text-sm font-medium text-white">No policies yet</div>
          <div className="text-2xs text-muted">Add a governance policy to continuously check your environments.</div>
        </div>
      ) : (
        <div className="divide-y divide-border-soft">
          {policies.data?.map((p) => {
            const ok = p.checkedCount - p.violationCount;
            const violated = p.violationCount > 0;
            return (
              <div key={p.id} className={`group flex items-center gap-3 border-l-[3px] px-4 py-3 transition hover:bg-card-hover ${p.enabled ? '' : 'opacity-60'}`} style={{ borderLeftColor: violated ? '#ef4444' : p.enabled ? '#22c55e' : '#64748b' }}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-base">{CATEGORY_ICON[p.category] ?? '📜'}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-white">{p.name}</span>
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-2xs capitalize" style={{ background: `${ENV_COLORS[p.scopeEnv] ?? '#64748b'}22`, color: ENV_COLORS[p.scopeEnv] ?? '#94a3b8' }}>{p.scopeEnv}</span>
                    {!p.enabled && <span className="shrink-0 rounded bg-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">paused</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
                    <span className="rounded-md border border-border-soft bg-bg px-1.5 py-0.5 text-muted-light">{ruleSummary(p)}</span>
                    <span className="capitalize">· {p.category}</span>
                    <span className={p.effect === 'alert' ? '· text-warning' : ''}>· {p.effect}</span>
                  </div>
                </div>
                {violated
                  ? <button onClick={() => setViewing(p)} className="shrink-0 rounded bg-danger/15 px-2 py-0.5 text-2xs font-medium text-danger hover:bg-danger/25">{p.violationCount} violation{p.violationCount === 1 ? '' : 's'}</button>
                  : <span className="shrink-0 rounded bg-success/15 px-2 py-0.5 text-2xs text-success">{ok}/{p.checkedCount} ✓</span>}
                <button
                  onClick={() => isAdmin && update.mutate({ id: p.id, enabled: !p.enabled })}
                  disabled={!isAdmin}
                  className={`relative h-4 w-7 shrink-0 rounded-full transition ${p.enabled ? 'bg-brand' : 'bg-border'} ${isAdmin ? '' : 'opacity-60'}`}
                  title={isAdmin ? (p.enabled ? 'Enabled — click to pause' : 'Paused — click to enable') : 'Admin only'}
                >
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${p.enabled ? 'left-3.5' : 'left-0.5'}`} />
                </button>
                {isAdmin && (
                  <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
                    <button onClick={() => setEditing(p)} className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-brand hover:text-white">Edit</button>
                    <DeleteBtn id={p.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {(adding || editing) && <PolicyModal policy={editing} onClose={() => { setAdding(false); setEditing(null); }} />}
      {viewing && <ViolationsModal policy={viewing} onClose={() => setViewing(null)} />}
    </Frame>
  );
}

function DeleteBtn({ id }: { id: string }) {
  const del = useDeletePolicy();
  return <button onClick={() => confirm('Delete this policy?') && del.mutate(id)} className="text-2xs text-danger hover:underline">Delete</button>;
}

function PolicyModal({ policy, onClose }: { policy: Policy | null; onClose: () => void }) {
  const create = useCreatePolicy();
  const update = useUpdatePolicy();
  const isEdit = !!policy;
  const [f, setF] = useState<any>({
    name: policy?.name ?? '', description: policy?.description ?? '', category: policy?.category ?? 'governance',
    scopeEnv: policy?.scopeEnv ?? 'production', ruleKind: policy?.ruleKind ?? 'require_tag', effect: policy?.effect ?? 'audit',
    enabled: policy?.enabled ?? true, tag: (policy?.ruleConfig as any)?.tag ?? 'Owner', value: (policy?.ruleConfig as any)?.value ?? '',
    regions: ((policy?.ruleConfig as any)?.regions ?? []).join(', '), amount: (policy?.ruleConfig as any)?.amount ?? 50,
  });
  const [err, setErr] = useState<string | null>(null);
  const buildConfig = () => {
    switch (f.ruleKind) {
      case 'require_tag': return { tag: f.tag };
      case 'required_tag_value': return { tag: f.tag, value: f.value };
      case 'allowed_regions': return { regions: String(f.regions).split(',').map((s: string) => s.trim()).filter(Boolean) };
      case 'max_monthly_cost': return { amount: Number(f.amount) };
      default: return {};
    }
  };
  const save = async () => {
    setErr(null);
    if (!f.name.trim()) return setErr('Name is required');
    const body = { name: f.name, description: f.description, category: f.category, scopeEnv: f.scopeEnv, ruleKind: f.ruleKind, ruleConfig: buildConfig(), effect: f.effect, enabled: f.enabled };
    try {
      if (isEdit) await update.mutateAsync({ id: policy!.id, ...body });
      else await create.mutateAsync(body);
      onClose();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title={isEdit ? 'Edit Policy' : 'Add Policy'} subtitle="Environment-scoped governance guardrail" onClose={onClose}>
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}
        <Field label="Policy name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inp} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Applies to environment">
            <select value={f.scopeEnv} onChange={(e) => setF({ ...f, scopeEnv: e.target.value })} className={inp}>
              {ENVS.map((x) => <option key={x} value={x} className="capitalize">{x}</option>)}
            </select>
          </Field>
          <Field label="Category">
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className={inp}>
              {['governance', 'tagging', 'security', 'cost', 'region', 'environment'].map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Rule">
          <select value={f.ruleKind} onChange={(e) => setF({ ...f, ruleKind: e.target.value })} className={inp}>
            {RULES.map((x) => <option key={x} value={x}>{RULE_LABELS[x]}</option>)}
          </select>
        </Field>
        {(f.ruleKind === 'require_tag' || f.ruleKind === 'required_tag_value') && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tag key"><input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} className={inp} /></Field>
            {f.ruleKind === 'required_tag_value' && <Field label="Required value"><input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} className={inp} /></Field>}
          </div>
        )}
        {f.ruleKind === 'allowed_regions' && <Field label="Allowed regions (comma-separated)"><input value={f.regions} onChange={(e) => setF({ ...f, regions: e.target.value })} placeholder="eastasia, us-east-1" className={inp} /></Field>}
        {f.ruleKind === 'max_monthly_cost' && <Field label="Max monthly cost"><input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className={inp} /></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Effect">
            <select value={f.effect} onChange={(e) => setF({ ...f, effect: e.target.value })} className={inp}>
              <option value="audit">Audit (record only)</option>
              <option value="alert">Alert (flag prominently)</option>
            </select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-2xs text-muted-light">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} className="accent-brand" /> Enabled
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={save} disabled={create.isPending || update.isPending} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{isEdit ? 'Save' : 'Create policy'}</button>
        </div>
      </div>
    </Modal>
  );
}

function ViolationsModal({ policy, onClose }: { policy: Policy; onClose: () => void }) {
  const v = usePolicyViolations(policy.id);
  return (
    <Modal title="Policy Violations" subtitle={policy.name} onClose={onClose}>
      <div className="max-h-96 divide-y divide-border-soft overflow-auto">
        {v.data?.map((x) => (
          <div key={x.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-2xs font-medium text-white">{x.resourceName}</div>
              <div className="text-2xs text-muted">{x.provider} · <span className="capitalize">{x.environment}</span></div>
            </div>
            <div className="shrink-0 text-2xs text-danger">{x.detail}</div>
          </div>
        ))}
        {v.data?.length === 0 && <div className="py-6 text-center text-2xs text-success">No violations 🎉</div>}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}
