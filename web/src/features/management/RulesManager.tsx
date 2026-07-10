'use client';

import { useState } from 'react';
import { Card, Modal, SeverityBadge } from '@/components/ui';
import { useAlertRules, useCreateRule, useDeleteRule, useUpdateRule, useTestRuleNotify } from '@/lib/hooks';
import { AgentInstallModal } from './AgentInstall';

const CMP_LABEL: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };
const PROVIDERS = ['', 'aws', 'azure', 'gcp', 'linux', 'windows'];
const ENVS = ['', 'production', 'staging', 'development', 'test'];
const METRIC_META: Record<string, { icon: string; label: string; unit: string }> = {
  cpu: { icon: '🧮', label: 'CPU', unit: '%' }, memory: { icon: '🧠', label: 'Memory', unit: '%' },
  disk: { icon: '💾', label: 'Disk', unit: '%' }, network: { icon: '🌐', label: 'Network', unit: ' Mbps' },
};
const EVENT_META: Record<string, { icon: string; label: string }> = {
  vm_power_off: { icon: '⏻', label: 'VM powered off' },
  vm_power_on: { icon: '⏼', label: 'VM powered on' },
  device_unreachable: { icon: '📡', label: 'Device unreachable (firewall / router / switch)' },
  agent_offline: { icon: '🖥', label: 'Guest agent offline' },
};
const NOTIFY_META: Record<string, { icon: string; label: string }> = {
  popup: { icon: '🔔', label: 'Pop-up' }, email: { icon: '✉️', label: 'Email' }, whatsapp: { icon: '💬', label: 'WhatsApp' },
};

type RuleRow = {
  id: string; name: string; kind?: string; metric: string; comparator: string; threshold: number;
  event?: string | null; severity: string; scopeProvider: string | null; scopeEnv?: string | null;
  notify?: string[]; notifyEmail?: string | null; notifyPhone?: string | null; enabled: boolean;
};

export function RulesManager({ bare = false }: { bare?: boolean }) {
  const rules = useAlertRules();
  const update = useUpdateRule();
  const del = useDeleteRule();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RuleRow | null>(null);

  const addBtn = (
    <button onClick={() => setShowForm(true)} className="widget-action rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">
      + Add Rule
    </button>
  );

  const table = (
    rules.data?.length === 0 ? (
      <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-card text-xl">🔔</span>
        <div className="text-sm font-medium text-white">No alert rules yet</div>
        <div className="max-w-sm text-2xs text-muted">Click <b className="text-white">+ Add Rule</b> to define a threshold (e.g. CPU &gt; 85%) or an infra event (VM on/off, device unreachable) — and pick how you&apos;re notified: pop-up, email or WhatsApp.</div>
      </div>
    ) : (
      <div className="divide-y divide-border-soft">
        {rules.data?.map((r) => {
          const isEvent = (r as RuleRow).kind === 'event';
          const ev = EVENT_META[(r as RuleRow).event ?? ''] ?? { icon: '⚡', label: (r as RuleRow).event ?? 'event' };
          const m = METRIC_META[r.metric] ?? { icon: '📊', label: r.metric, unit: '' };
          const notify = (r as RuleRow).notify ?? [];
          return (
            <div key={r.id} className={`group flex items-center gap-3 px-4 py-3 transition hover:bg-card-hover ${r.enabled ? '' : 'opacity-60'}`}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-base">{isEvent ? ev.icon : m.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-white">{r.name}</span>
                  {!r.enabled && <span className="shrink-0 rounded bg-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">paused</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
                  <span className="rounded-md border border-border-soft bg-bg px-1.5 py-0.5 font-mono text-muted-light">{isEvent ? `event · ${ev.label}` : `${m.label} ${CMP_LABEL[r.comparator]} ${r.threshold}${m.unit}`}</span>
                  <span>·</span>
                  <span>{r.scopeProvider ? r.scopeProvider.toUpperCase() : 'All providers'}{(r as RuleRow).scopeEnv ? ` · ${(r as RuleRow).scopeEnv}` : ''}</span>
                  {notify.length > 0 && <span className="flex items-center gap-1">· {notify.map((n) => <span key={n} title={NOTIFY_META[n]?.label} className="rounded bg-brand/10 px-1 text-brand">{NOTIFY_META[n]?.icon ?? n}</span>)}</span>}
                </div>
              </div>
              <SeverityBadge severity={r.severity} />
              <button
                onClick={() => update.mutate({ id: r.id, enabled: !r.enabled })}
                title={r.enabled ? 'Enabled — click to pause' : 'Paused — click to enable'}
                className={`relative h-4 w-7 shrink-0 rounded-full transition ${r.enabled ? 'bg-brand' : 'bg-border'}`}
              >
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${r.enabled ? 'left-3.5' : 'left-0.5'}`} />
              </button>
              <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
                <button onClick={() => setEditing(r as RuleRow)} title="Edit rule" className="widget-action rounded-md border border-border bg-card px-2 py-1 text-2xs text-brand hover:text-white">✎</button>
                <button onClick={() => confirm(`Delete alert rule “${r.name}”?`) && del.mutate(r.id)} title="Delete rule" className="widget-action rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted hover:border-danger/50 hover:text-danger">✕</button>
              </div>
            </div>
          );
        })}
      </div>
    )
  );

  const modal = (showForm || editing) && <AddRuleModal rule={editing} onClose={() => { setShowForm(false); setEditing(null); }} />;

  if (bare) {
    return (
      <div className="-m-3 flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-2xs text-muted">{rules.data?.length ?? 0} rule(s)</span>
          {addBtn}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{table}</div>
        {modal}
      </div>
    );
  }

  return (
    <Card title={`Alert Rules${rules.data ? ` (${rules.data.length})` : ''}`} className="col-span-12" action={addBtn} bodyClassName="p-0">
      {table}
      {modal}
    </Card>
  );
}

function AddRuleModal({ rule, onClose }: { rule?: RuleRow | null; onClose: () => void }) {
  const create = useCreateRule();
  const update = useUpdateRule();
  const test = useTestRuleNotify();
  const isEdit = !!rule;
  const [agent, setAgent] = useState(false);
  const [f, setF] = useState({
    name: rule?.name ?? '', kind: rule?.kind ?? 'threshold',
    metric: rule?.metric ?? 'cpu', comparator: rule?.comparator ?? 'gt', threshold: rule?.threshold ?? 85,
    event: rule?.event ?? 'device_unreachable',
    severity: rule?.severity ?? 'high', scopeProvider: rule?.scopeProvider ?? '', scopeEnv: rule?.scopeEnv ?? '',
    notify: rule?.notify ?? ['popup'], notifyEmail: rule?.notifyEmail ?? '', notifyPhone: rule?.notifyPhone ?? '',
  });
  const isEvent = f.kind === 'event';
  const needsAgent = !isEvent && (f.metric === 'memory' || f.metric === 'disk');
  const busy = create.isPending || update.isPending;
  const toggleNotify = (n: string) => setF({ ...f, notify: f.notify.includes(n) ? f.notify.filter((x) => x !== n) : [...f.notify, n] });

  const sendTest = () => test.mutate({ name: f.name || 'Alert rule', severity: f.severity, notify: f.notify, notifyEmail: f.notifyEmail || null, notifyPhone: f.notifyPhone || null });

  const save = async () => {
    if (!f.name.trim()) return;
    const body: any = { name: f.name.trim(), kind: f.kind, severity: f.severity, scopeProvider: f.scopeProvider || null, notify: f.notify, notifyEmail: f.notifyEmail || null, notifyPhone: f.notifyPhone || null };
    if (isEvent) { body.event = f.event; }
    else { body.metric = f.metric; body.comparator = f.comparator; body.threshold = Number(f.threshold); body.scopeEnv = f.scopeEnv || null; }
    if (isEdit) await update.mutateAsync({ id: rule!.id, ...body });
    else await create.mutateAsync(body);
    onClose();
  };

  return (
    <>
      <Modal title={isEdit ? 'Edit Alert Rule' : 'Add Alert Rule'} subtitle="Evaluated on live data every minute — notifies via pop-up, email or WhatsApp" onClose={onClose} wide>
        <div className="space-y-3">
          <Field label="Rule name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Production firewall unreachable" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
          </Field>

          <Field label="Trigger type">
            <div className="flex gap-1 rounded-lg border border-border bg-bg p-1">
              {([['threshold', '📈 Metric threshold'], ['event', '⚡ Infra event']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setF({ ...f, kind: k })} className={`flex-1 rounded-md px-3 py-1.5 text-xs transition ${f.kind === k ? 'bg-brand text-white' : 'text-muted-light hover:text-white'}`}>{label}</button>
              ))}
            </div>
          </Field>

          {isEvent ? (
            <Field label="Event">
              <Select value={f.event} onChange={(v) => setF({ ...f, event: v })} options={[
                ['device_unreachable', '📡 Device unreachable (firewall / router / switch / host)'],
                ['vm_power_off', '⏻ VM powered off'],
                ['vm_power_on', '⏼ VM powered on'],
                ['agent_offline', '🖥 Guest agent offline'],
              ]} />
            </Field>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Metric">
                <Select value={f.metric} onChange={(v) => setF({ ...f, metric: v })} options={[['cpu', 'CPU %'], ['memory', 'Memory %'], ['disk', 'Disk %'], ['network', 'Network Mbps']]} />
              </Field>
              <Field label="Condition">
                <Select value={f.comparator} onChange={(v) => setF({ ...f, comparator: v })} options={[['gt', '> greater'], ['gte', '≥'], ['lt', '< less'], ['lte', '≤']]} />
              </Field>
              <Field label={f.metric === 'network' ? 'Threshold (Mbps)' : 'Threshold %'}>
                <input type="number" value={f.threshold} onChange={(e) => setF({ ...f, threshold: Number(e.target.value) })} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none" />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Field label="Severity">
              <Select value={f.severity} onChange={(v) => setF({ ...f, severity: v })} options={[['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]} />
            </Field>
            <Field label="Cloud / provider">
              <Select value={f.scopeProvider} onChange={(v) => setF({ ...f, scopeProvider: v })} options={PROVIDERS.map((p) => [p, p ? p.toUpperCase() : 'All providers'])} />
            </Field>
            {!isEvent && (
              <Field label="Environment">
                <Select value={f.scopeEnv} onChange={(v) => setF({ ...f, scopeEnv: v })} options={ENVS.map((e) => [e, e ? e[0].toUpperCase() + e.slice(1) : 'All environments'])} />
              </Field>
            )}
          </div>

          <Field label="Notify via">
            <div className="flex flex-wrap gap-2">
              {(['popup', 'email', 'whatsapp'] as const).map((n) => {
                const on = f.notify.includes(n);
                return (
                  <button key={n} onClick={() => toggleNotify(n)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${on ? 'border-brand bg-brand/15 text-white' : 'border-border bg-bg text-muted-light hover:text-white'}`}>
                    <span>{NOTIFY_META[n].icon}</span> {NOTIFY_META[n].label} {on && <span className="text-brand">✓</span>}
                  </button>
                );
              })}
            </div>
            {(f.notify.includes('email') || f.notify.includes('whatsapp')) && (
              <div className="mt-2 grid grid-cols-2 gap-3">
                {f.notify.includes('email') && (
                  <div>
                    <span className="mb-1 block text-2xs text-muted">Send to email (optional)</span>
                    <input value={f.notifyEmail} onChange={(e) => setF({ ...f, notifyEmail: e.target.value })} placeholder="ops@yourco.com" className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
                  </div>
                )}
                {f.notify.includes('whatsapp') && (
                  <div>
                    <span className="mb-1 block text-2xs text-muted">Send to WhatsApp number</span>
                    <input value={f.notifyPhone} onChange={(e) => setF({ ...f, notifyPhone: e.target.value })} placeholder="+91XXXXXXXXXX" className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
                  </div>
                )}
              </div>
            )}
            <div className="mt-1.5 text-2xs text-muted">Pop-up shows in-app instantly. Leave email/number blank to use the channels in <b className="text-muted-light">Settings → Integrations / Notification Channels</b> (email falls back to admins).</div>
            <div className="mt-2 flex items-center gap-2">
              <button onClick={sendTest} disabled={test.isPending || (!f.notify.includes('email') && !f.notify.includes('whatsapp') && !f.notify.includes('popup'))} className="rounded-lg border border-brand/40 bg-brand/10 px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/20 disabled:opacity-50">{test.isPending ? 'Sending test…' : '🧪 Send test notification'}</button>
              <span className="text-2xs text-muted">Verifies delivery now, without waiting for the alert to fire.</span>
            </div>
            {test.data && (
              <div className="mt-2 space-y-1 rounded-lg border border-border bg-bg/40 p-2.5">
                {test.data.results.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-2xs">
                    <span className={r.ok ? 'text-success' : 'text-danger'}>{r.ok ? '✓' : '✕'}</span>
                    <span className="font-medium text-white">{r.channel}</span>
                    <span className="text-muted-light">— {r.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </Field>

          {needsAgent && (
            <div className="rounded-lg border border-warning/20 bg-warning/5 p-3 text-2xs text-muted-light">
              ⚠ {f.metric} % needs the guest monitoring agent installed on the VM.{' '}
              <button onClick={() => setAgent(true)} className="font-medium text-brand hover:underline">Open install guide →</button>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
            <button onClick={save} disabled={busy || !f.name.trim()} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Save rule'}
            </button>
          </div>
        </div>
      </Modal>
      {agent && <AgentInstallModal onClose={() => setAgent(false)} />}
    </>
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

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-border bg-bg px-2 py-2 text-sm text-white focus:border-brand focus:outline-none">
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
}
