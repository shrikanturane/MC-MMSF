'use client';

import { Card, ErrorState, LoadingState, Modal } from '@/components/ui';
import { useAuthUser } from '@/lib/auth';
import { useState } from 'react';
import { useApprovals, useApprovalPolicies, useApproveRequest, useRejectRequest, useRetryRequest, useSetApprovalPolicy, useCreateApprovalPolicy, useDeleteApprovalPolicy, useSettings } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import type { ApprovalRequest } from '@/lib/types';
import { ProvisionModal, type ProvisionInitial } from '@/features/topology/TopologyView';

const ACTION_KIND: Record<string, 'network' | 'vm' | 'disk'> = { network_provision: 'network', vm_provision: 'vm', disk_provision: 'disk' };
const actionIcon = (action: string): string => {
  if (/network/.test(action)) return '🌐';
  if (/disk/.test(action)) return '💾';
  if (/stop/.test(action)) return '⏹';
  if (/start/.test(action)) return '▶';
  if (/reboot|restart/.test(action)) return '🔁';
  if (/provision|deploy|vm/.test(action)) return '🚀';
  return '📋';
};

const STATUS_COLORS: Record<string, string> = {
  pending: '#f59e0b',
  approved: '#22c55e',
  executed: '#22c55e',
  rejected: '#ef4444',
  failed: '#ef4444',
  expired: '#64748b',
};

export function ApprovalsView() {
  const { data: me } = useAuthUser();
  const isAdmin = me?.role === 'admin';
  const all = useApprovals();
  const approve = useApproveRequest();
  const reject = useRejectRequest();
  const settings = useSettings();
  const [edit, setEdit] = useState<ProvisionInitial | null>(null);
  const makerChecker = !!settings.data?.makerChecker;
  // Under maker-checker a requester can't approve their own request — a DIFFERENT admin must.
  const isOwn = (r: { requestedByEmail: string }) => !!me?.email && r.requestedByEmail === me.email;

  if (all.isLoading) return <LoadingState rows={6} />;
  if (all.isError) return <ErrorState />;

  const pending = (all.data ?? []).filter((r) => r.status === 'pending');
  const history = (all.data ?? []).filter((r) => r.status !== 'pending');

  return (
    <div className="space-y-4">
      {/* Approval Process Control (maker-checker) moved to Settings → "Approval Process — Maker-Checker". */}
      {/* Pending */}
      <Card title={`${isAdmin ? 'Pending Approvals' : 'My Pending Requests'} (${pending.length})`} bodyClassName="p-0">
        {pending.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-success/30 bg-success/10 text-lg">✅</span>
            <div className="text-sm font-medium text-white">Nothing pending</div>
            <div className="text-2xs text-muted">{isAdmin ? 'No actions are waiting for your approval.' : 'You have no requests awaiting approval.'}</div>
          </div>
        ) : (
          <div className="divide-y divide-border-soft">
            {pending.map((r) => (
              <div key={r.id} className="flex items-center gap-3 border-l-[3px] border-l-warning px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-warning/30 bg-warning/10 text-base">{actionIcon(r.action)}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white">{r.title}</div>
                  <div className="text-2xs text-muted">
                    by {r.requestedByEmail} · {timeAgo(r.createdAt)} · <span className="text-warning">expires {timeAgo(r.expiresAt).replace(' ago', '')}</span>
                  </div>
                </div>
                {isAdmin ? (
                  makerChecker && isOwn(r) ? (
                    <span className="shrink-0 rounded bg-warning/15 px-2 py-0.5 text-2xs text-warning" title="Maker-checker: another administrator must approve your own request.">your request — awaiting another admin</span>
                  ) : (
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => approve.mutate(r.id)} disabled={approve.isPending} className="rounded-md bg-success/15 px-3 py-1.5 text-2xs font-medium text-success hover:bg-success/25 disabled:opacity-50">✓ Approve</button>
                    <button onClick={() => reject.mutate({ id: r.id, note: prompt('Reason (optional):') ?? undefined })} disabled={reject.isPending} className="rounded-md bg-danger/15 px-3 py-1.5 text-2xs font-medium text-danger hover:bg-danger/25 disabled:opacity-50">✕ Reject</button>
                  </div>
                  )
                ) : (
                  <span className="shrink-0 rounded bg-warning/15 px-2 py-0.5 text-2xs text-warning">awaiting approval</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* History — with deployment status, failure phase + fix, and retry */}
      <Card title="Request History" bodyClassName="p-0">
        <div className="max-h-[28rem] divide-y divide-border-soft overflow-auto">
          {history.map((r) => <HistoryRow key={r.id} r={r} canRetry={isAdmin || !!r.mine} onEdit={setEdit} />)}
          {history.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">No history yet.</div>}
        </div>
      </Card>

      {isAdmin && <PoliciesCard />}

      {edit && <ProvisionModal providers={[edit.provider]} initial={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

const GATED_ACTIONS: [string, string][] = [
  ['vm_start', 'Start a virtual machine'],
  ['vm_stop', 'Stop a virtual machine'],
  ['vm_reboot', 'Reboot a virtual machine'],
  ['connection_delete', 'Delete a cloud connection'],
  ['network_remediate', 'Remediate a firewall / NSG rule'],
  ['network_provision', 'Provision a network resource'],
  ['vm_provision', 'Provision a virtual machine'],
  ['disk_provision', 'Provision a disk'],
  ['vpn_request', 'Request a VPN tunnel'],
];
type PolicyRow = { id: string; action: string; label: string; requiresApproval: boolean; autoApproveAdmin: boolean };

function PoliciesCard() {
  const policies = useApprovalPolicies();
  const setPolicy = useSetApprovalPolicy();
  const del = useDeleteApprovalPolicy();
  const [form, setForm] = useState<{ policy: PolicyRow | null } | null>(null);
  const existing = new Set((policies.data ?? []).map((p) => p.action));

  return (
    <Card
      title="Approval Policies"
      bodyClassName="p-0"
      action={<button onClick={() => setForm({ policy: null })} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ Add Policy</button>}
    >
      <div className="divide-y divide-border-soft">
        {policies.data?.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card text-lg">🛡</span>
            <div className="text-sm font-medium text-white">No approval policies</div>
            <div className="text-2xs text-muted">Add one to require approval before a sensitive action runs.</div>
          </div>
        )}
        {(policies.data as PolicyRow[] | undefined)?.map((p) => (
          <div key={p.id} className="group flex items-center gap-3 px-4 py-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-sm">{actionIcon(p.action)}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-2xs font-medium text-white">{p.label}</div>
              <div className="text-2xs text-muted">
                {p.requiresApproval ? <span className="text-warning">Requires approval</span> : <span>Auto-executes</span>} · admins {p.autoApproveAdmin ? 'bypass' : 'also need approval'}
              </div>
            </div>
            <button
              onClick={() => setPolicy.mutate({ id: p.id, requiresApproval: !p.requiresApproval })}
              className={`relative h-4 w-7 shrink-0 rounded-full transition ${p.requiresApproval ? 'bg-brand' : 'bg-border'}`}
              title="Toggle approval requirement"
            >
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${p.requiresApproval ? 'left-3.5' : 'left-0.5'}`} />
            </button>
            <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
              <button onClick={() => setForm({ policy: p })} title="Edit policy" className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-brand hover:text-white">✎</button>
              <button onClick={() => confirm(`Delete the “${p.label}” approval policy? That action will then run without approval.`) && del.mutate(p.id)} title="Delete policy" className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted hover:border-danger/50 hover:text-danger">✕</button>
            </div>
          </div>
        ))}
      </div>
      {form && <PolicyModal policy={form.policy} existing={existing} onClose={() => setForm(null)} />}
    </Card>
  );
}

/** Add or edit an approval policy for a gated action. */
function PolicyModal({ policy, existing, onClose }: { policy: PolicyRow | null; existing: Set<string>; onClose: () => void }) {
  const create = useCreateApprovalPolicy();
  const update = useSetApprovalPolicy();
  const isEdit = !!policy;
  const available = GATED_ACTIONS.filter(([a]) => !existing.has(a));
  const [f, setF] = useState({
    action: policy?.action ?? available[0]?.[0] ?? 'vm_stop',
    label: policy?.label ?? (available[0]?.[1] ?? ''),
    requiresApproval: policy?.requiresApproval ?? true,
    autoApproveAdmin: policy?.autoApproveAdmin ?? true,
  });
  const busy = create.isPending || update.isPending;
  const save = async () => {
    if (isEdit) await update.mutateAsync({ id: policy!.id, label: f.label.trim(), requiresApproval: f.requiresApproval, autoApproveAdmin: f.autoApproveAdmin });
    else await create.mutateAsync({ action: f.action, label: f.label.trim() || f.action, requiresApproval: f.requiresApproval, autoApproveAdmin: f.autoApproveAdmin });
    onClose();
  };
  return (
    <Modal title={isEdit ? 'Edit Approval Policy' : 'Add Approval Policy'} subtitle="Gate a sensitive action behind approval" onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Action</span>
          {isEdit ? (
            <div className="rounded-lg border border-border bg-bg/50 px-3 py-2 text-sm text-muted-light">{actionIcon(f.action)} {f.action}</div>
          ) : available.length === 0 ? (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-2xs text-warning">All gated actions already have a policy — edit one instead.</div>
          ) : (
            <select value={f.action} onChange={(e) => { const lbl = GATED_ACTIONS.find(([a]) => a === e.target.value)?.[1] ?? ''; setF({ ...f, action: e.target.value, label: lbl }); }} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none">
              {available.map(([a, l]) => <option key={a} value={a}>{l} ({a})</option>)}
            </select>
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Label</span>
          <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Shown in the policy list" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </label>
        <label className="flex items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2 text-xs">
          <span><span className="block font-medium text-white">Requires approval</span><span className="block text-2xs text-muted">Operators must get an admin to approve before it runs.</span></span>
          <input type="checkbox" checked={f.requiresApproval} onChange={(e) => setF({ ...f, requiresApproval: e.target.checked })} className="h-4 w-4 accent-brand" />
        </label>
        <label className="flex items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2 text-xs">
          <span><span className="block font-medium text-white">Admins bypass</span><span className="block text-2xs text-muted">Admins execute directly without approval (uncheck to require it for everyone).</span></span>
          <input type="checkbox" checked={f.autoApproveAdmin} onChange={(e) => setF({ ...f, autoApproveAdmin: e.target.checked })} className="h-4 w-4 accent-brand" />
        </label>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={save} disabled={busy || (!isEdit && available.length === 0)} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add policy'}</button>
        </div>
      </div>
    </Modal>
  );
}

function HistoryRow({ r, canRetry, onEdit }: { r: ApprovalRequest; canRetry: boolean; onEdit: (i: ProvisionInitial) => void }) {
  const retry = useRetryRequest();
  const failed = r.status === 'failed';
  const executed = r.status === 'executed';
  const editKind = ACTION_KIND[r.action];
  const editResubmit = () => {
    const p = r.payload ?? {};
    const values = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v == null ? '' : String(v)]));
    onEdit({ provider: String(p.provider ?? ''), kind: editKind, values });
  };
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Pill status={r.status} />
            {executed && <span className="text-2xs text-success">deployed ✓</span>}
            {failed && <span className="text-2xs text-danger">not deployed ✕</span>}
            {!!r.retries && <span className="rounded bg-border/40 px-1.5 py-0.5 text-2xs text-muted">retried ×{r.retries}</span>}
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-white">{r.title}</div>
          <div className="text-2xs text-muted">
            by {r.requestedByEmail}{r.approverEmail ? ` · approved by ${r.approverEmail}` : ''} · {timeAgo(r.decidedAt ?? r.createdAt)}
          </div>
        </div>
        {failed && r.retryable && canRetry && (
          <div className="flex shrink-0 items-center gap-2">
            {editKind && r.payload?.provider && (
              <button onClick={editResubmit} className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs font-medium text-brand hover:text-white">✎ Edit & resubmit</button>
            )}
            <button onClick={() => retry.mutate(r.id)} disabled={retry.isPending} className="rounded-md bg-brand/15 px-3 py-1.5 text-2xs font-medium text-brand hover:bg-brand/25 disabled:opacity-50">
              {retry.isPending ? 'Retrying…' : '↻ Retry deploy'}
            </button>
          </div>
        )}
      </div>

      {/* Result / failure phase + remediation */}
      {r.result && (
        <div className={`mt-1.5 rounded-lg border px-3 py-1.5 text-2xs ${failed ? 'border-danger/30 bg-danger/10 text-danger' : 'border-border bg-card/50 text-muted-light'}`}>
          {failed && r.phase && <span className="mr-1 font-semibold">Failed at “{r.phase}”:</span>}
          {r.result}
          {failed && r.remediation && (
            <div className="mt-1 text-amber-300/90"><span className="font-semibold">To fix:</span> {r.remediation} <span className="text-muted">Then click ↻ Retry deploy — no re-approval needed.</span></div>
          )}
        </div>
      )}
    </div>
  );
}

function Pill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? '#64748b';
  return <span className="rounded px-1.5 py-0.5 text-2xs capitalize" style={{ background: `${c}22`, color: c }}>{status}</span>;
}
