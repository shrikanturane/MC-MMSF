'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui';
import { useCreateWorkflow, useUpdateWorkflow, useChannels } from '@/lib/hooks';
import type { Workflow } from '@/lib/types';

type Cond = { field: string; op: string; value: string };
type Step = { type: string; config: Record<string, any> };
type Tier = { afterMinutes: number; steps: Step[] };

const FIELDS = [['severity', 'Severity'], ['metric', 'Metric'], ['source', 'Source'], ['resourceName', 'Resource'], ['value', 'Value']];
const OPS = [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['contains', 'contains']];
const STEP_TYPES = [
  ['notify', 'Notify channels'],
  ['webhook', 'Call webhook'],
  ['create_approval', 'Create approval request'],
  ['stop_vm', 'Stop the VM'],
  ['restart_vm', 'Restart the VM'],
  ['log', 'Write event log'],
];

function describeTrigger(kind: string, value: string): string {
  if (kind === 'severity') return `severity = ${value || '…'}`;
  if (kind === 'metric') return `metric = ${value || '…'}`;
  return 'any alert';
}

/**
 * Unified Automation builder. One rule = WHEN (trigger + conditions) → THEN (ordered steps)
 * → ESCALATE (ordered time tiers, each its own steps). Creates or edits a workflow.
 */
export function WorkflowBuilder({ initial, onClose }: { initial?: Workflow | null; onClose: () => void }) {
  const create = useCreateWorkflow();
  const update = useUpdateWorkflow();
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState(initial ? initial.status === 'enabled' : true);
  const [triggerKind, setTriggerKind] = useState(initial?.triggerKind || 'any');
  const [triggerValue, setTriggerValue] = useState(initial?.triggerValue || '');
  const [conditions, setConditions] = useState<Cond[]>((initial?.conditions as Cond[]) ?? []);
  const [steps, setSteps] = useState<Step[]>(
    initial?.steps && initial.steps.length ? (initial.steps as Step[]).map((s) => ({ type: s.type, config: (s.config as any) ?? {} })) : [{ type: 'notify', config: {} }],
  );
  const [tiers, setTiers] = useState<Tier[]>(
    (initial?.escalation ?? []).map((t) => ({ afterMinutes: t.afterMinutes, steps: (t.steps as Step[]).map((s) => ({ type: s.type, config: (s.config as any) ?? {} })) })),
  );
  const [err, setErr] = useState<string | null>(null);

  const addCond = () => setConditions([...conditions, { field: 'severity', op: 'eq', value: '' }]);
  const setCond = (i: number, patch: Partial<Cond>) => setConditions(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const delCond = (i: number) => setConditions(conditions.filter((_, j) => j !== i));

  const addTier = () => setTiers([...tiers, { afterMinutes: tiers.length ? tiers[tiers.length - 1].afterMinutes * 2 : 15, steps: [{ type: 'notify', config: {} }] }]);
  const setTier = (i: number, patch: Partial<Tier>) => setTiers(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const delTier = (i: number) => setTiers(tiers.filter((_, j) => j !== i));

  const save = async () => {
    setErr(null);
    if (!name.trim()) return setErr('Name is required');
    if (steps.length === 0) return setErr('Add at least one action step');
    const body = {
      name: name.trim(),
      triggerKind,
      triggerValue: triggerValue || null,
      trigger: describeTrigger(triggerKind, triggerValue),
      conditions: conditions.filter((c) => c.value !== '' || c.op === 'contains'),
      steps,
      escalation: tiers.filter((t) => t.steps.length > 0).map((t) => ({ afterMinutes: Number(t.afterMinutes) || 15, steps: t.steps })),
      enabled,
      actionType: 'notify',
    };
    try {
      if (editing && initial) await update.mutateAsync({ id: initial.id, ...body });
      else await create.mutateAsync(body);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal title={editing ? 'Edit Automation' : 'New Automation'} subtitle="When an alert matches → run actions, then escalate if it stays unresolved" onClose={onClose}>
      <div className="space-y-4">
        {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}

        <div className="flex items-end gap-3">
          <Field label="Automation name" className="flex-1"><input value={name} onChange={(e) => setName(e.target.value)} className={inp} placeholder="e.g. Critical prod CPU response" /></Field>
          <label className="flex items-center gap-1.5 pb-2 text-2xs text-muted-light"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
        </div>

        {/* WHEN */}
        <Section label="When" tone="#3b82f6">
          <div className="grid grid-cols-2 gap-2">
            <Sel value={triggerKind} onChange={(v) => { setTriggerKind(v); setTriggerValue(''); }} options={[['any', 'On any alert'], ['severity', 'On severity'], ['metric', 'On metric']]} />
            {triggerKind === 'severity' ? (
              <Sel value={triggerValue} onChange={setTriggerValue} options={[['', 'Choose…'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]} />
            ) : triggerKind === 'metric' ? (
              <Sel value={triggerValue} onChange={setTriggerValue} options={[['', 'Choose…'], ['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk']]} />
            ) : <div />}
          </div>
          <div className="mt-3 space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="text-2xs text-muted">and</span>
                <Sel value={c.field} onChange={(v) => setCond(i, { field: v })} options={FIELDS} small />
                <Sel value={c.op} onChange={(v) => setCond(i, { op: v })} options={OPS} small />
                <input value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="value" className={`${inp} py-1 text-2xs`} />
                <button onClick={() => delCond(i)} className="text-2xs text-danger hover:underline">×</button>
              </div>
            ))}
            <button onClick={addCond} className="text-2xs text-brand hover:underline">+ add condition</button>
          </div>
        </Section>

        {/* THEN */}
        <Section label="Then, in order" tone="#22c55e">
          <StepList steps={steps} setSteps={setSteps} />
        </Section>

        {/* ESCALATE */}
        <Section label="Escalate if still unresolved" tone="#a855f7">
          {tiers.length === 0 && <div className="mb-2 text-2xs text-muted">No escalation. Add a tier to run more actions when the alert stays open.</div>}
          <div className="space-y-3">
            {tiers.map((t, i) => (
              <div key={i} className="rounded-lg border border-purple-500/30 bg-purple-500/[0.04] p-2.5">
                <div className="mb-2 flex items-center gap-2 text-2xs text-muted-light">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-purple-500/20 text-purple-300">{i + 1}</span>
                  after
                  <input type="number" min={1} value={t.afterMinutes} onChange={(e) => setTier(i, { afterMinutes: Number(e.target.value) })} className="w-16 rounded border border-border bg-bg px-2 py-1 text-xs text-white focus:border-brand focus:outline-none" />
                  minutes unresolved →
                  <button onClick={() => delTier(i)} className="ml-auto text-2xs text-danger hover:underline">remove tier</button>
                </div>
                <StepList steps={t.steps} setSteps={(s) => setTier(i, { steps: typeof s === 'function' ? (s as (p: Step[]) => Step[])(t.steps) : s })} />
              </div>
            ))}
          </div>
          <button onClick={addTier} className="mt-2 text-2xs text-purple-300 hover:underline">+ add escalation tier</button>
        </Section>

        {(steps.some((s) => s.type === 'stop_vm' || s.type === 'restart_vm') || tiers.some((t) => t.steps.some((s) => s.type === 'stop_vm' || s.type === 'restart_vm'))) && (
          <div className="text-2xs text-warning">⚠ A power-action step takes a real stop/restart on the alert's VM. Consider a "Create approval request" step for sign-off.</div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{busy ? 'Saving…' : editing ? 'Save changes' : 'Create automation'}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Reusable ordered step editor — used by both "Then" and each escalation tier. */
function StepList({ steps, setSteps }: { steps: Step[]; setSteps: (s: Step[] | ((p: Step[]) => Step[])) => void }) {
  const apply = (fn: (p: Step[]) => Step[]) => setSteps((prev) => fn(prev));
  const addStep = () => apply((p) => [...p, { type: 'notify', config: {} }]);
  const setStep = (i: number, patch: Partial<Step>) => apply((p) => p.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setStepCfg = (i: number, k: string, v: any) => apply((p) => p.map((s, j) => (j === i ? { ...s, config: { ...s.config, [k]: v } } : s)));
  const delStep = (i: number) => apply((p) => p.filter((_, j) => j !== i));
  const moveStep = (i: number, dir: -1 | 1) =>
    apply((p) => {
      const j = i + dir;
      if (j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <div>
      <div className="space-y-2">
        {steps.map((s, i) => (
          <div key={i} className="rounded-lg border border-border bg-bg p-2">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/20 text-2xs text-brand">{i + 1}</span>
              <Sel value={s.type} onChange={(v) => setStep(i, { type: v, config: {} })} options={STEP_TYPES} />
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => moveStep(i, -1)} disabled={i === 0} className="text-2xs text-muted hover:text-white disabled:opacity-30">↑</button>
                <button onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="text-2xs text-muted hover:text-white disabled:opacity-30">↓</button>
                <button onClick={() => delStep(i)} className="text-2xs text-danger hover:underline">×</button>
              </div>
            </div>
            <StepConfig step={s} onCfg={(k, v) => setStepCfg(i, k, v)} />
          </div>
        ))}
        {steps.length === 0 && <div className="text-2xs text-muted">No steps yet.</div>}
      </div>
      <button onClick={addStep} className="mt-2 text-2xs text-brand hover:underline">+ add step</button>
    </div>
  );
}

function StepConfig({ step, onCfg }: { step: Step; onCfg: (k: string, v: any) => void }) {
  const channels = useChannels();
  if (step.type === 'webhook') return <input value={step.config.url ?? ''} onChange={(e) => onCfg('url', e.target.value)} placeholder="https://hooks.example.com/…" className={`${inp} mt-2 text-2xs`} />;
  if (step.type === 'notify') {
    const selected: string[] = step.config.channelIds ?? [];
    const toggle = (id: string) => onCfg('channelIds', selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    return (
      <div className="mt-2 space-y-2">
        <input value={step.config.label ?? ''} onChange={(e) => onCfg('label', e.target.value)} placeholder="optional note for the notification" className={`${inp} text-2xs`} />
        <div>
          <div className="mb-1 text-2xs text-muted">Send to channels {selected.length === 0 && <span className="text-muted-light">(all enabled by default)</span>}:</div>
          <div className="flex flex-wrap gap-1.5">
            {channels.data?.map((c) => (
              <button key={c.id} type="button" onClick={() => toggle(c.id)} className={`rounded-full border px-2 py-0.5 text-2xs ${selected.includes(c.id) ? 'border-brand bg-brand/15 text-white' : 'border-border bg-card text-muted-light hover:text-white'}`}>
                {c.name} · {c.type}
              </button>
            ))}
            {channels.data?.length === 0 && <span className="text-2xs text-muted">No channels yet — add one in the Delivery Channels section below.</span>}
          </div>
        </div>
      </div>
    );
  }
  if (step.type === 'log') return <input value={step.config.message ?? ''} onChange={(e) => onCfg('message', e.target.value)} placeholder="event log message" className={`${inp} mt-2 text-2xs`} />;
  if (step.type === 'create_approval')
    return (
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Sel value={step.config.action ?? 'vm_stop'} onChange={(v) => onCfg('action', v)} options={[['vm_stop', 'Stop VM'], ['vm_reboot', 'Reboot VM']]} small />
        <input value={step.config.title ?? ''} onChange={(e) => onCfg('title', e.target.value)} placeholder="approval title (optional)" className={`${inp} py-1 text-2xs`} />
      </div>
    );
  return null;
}

function Section({ label, tone, children }: { label: string; tone: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 flex items-center gap-2 text-2xs font-medium uppercase tracking-wide" style={{ color: tone }}>
        <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
        {label}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

function Sel({ value, onChange, options, small }: { value: string; onChange: (v: string) => void; options: string[][]; small?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`rounded-lg border border-border bg-bg px-2 text-white focus:border-brand focus:outline-none ${small ? 'py-1 text-2xs' : 'py-2 text-xs'}`}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

const inp = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none';
