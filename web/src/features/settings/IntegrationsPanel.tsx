'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, Modal } from '@/components/ui';
import { PasswordInput } from '@/components/PasswordInput';
import { timeAgo } from '@/lib/format';
import { useIntegrations, useUpdateIntegrations, useDeliveries, useRetryDelivery, useDeleteDelivery, useTestIntegration, useRemoveIntegration, useSettings, useUpdateSettings, useIntegrationsHealth, useRunIntegrationHealth } from '@/lib/hooks';
import type { IntegrationField } from '@/lib/types';

type Provider = {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  /** field providers to pull into this integration's editor */
  fieldProviders: string[];
  /** own keys whose presence marks the integration as "added"/connected */
  ownKeys: string[];
  /** test needs a recipient (email/phone) */
  testTarget?: { label: string; placeholder: string };
  builtin?: boolean;
};

const PROVIDERS: Provider[] = [
  {
    id: 'email',
    name: 'Email (SMTP)',
    icon: '✉️',
    blurb: 'Default channel for alerts, scheduled reports and password-reset links.',
    fieldProviders: ['email'],
    ownKeys: ['SMTP_HOST'],
    testTarget: { label: 'Send test email to', placeholder: 'you@company.com' },
    builtin: true,
  },
  {
    id: 'google',
    name: 'Single Sign-On — Google',
    icon: '🔵',
    blurb: 'Let users sign in with their Google Workspace account.',
    fieldProviders: ['sso-common', 'google'],
    ownKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  },
  {
    id: 'microsoft',
    name: 'Single Sign-On — Microsoft',
    icon: '⊞',
    blurb: 'Let users sign in with Microsoft Entra ID / Azure AD.',
    fieldProviders: ['sso-common', 'microsoft'],
    ownKeys: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp (Meta Cloud API)',
    icon: '💬',
    blurb: 'Send alert notifications over WhatsApp.',
    fieldProviders: ['whatsapp'],
    ownKeys: ['WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN'],
    testTarget: { label: 'Send test message to', placeholder: '+91XXXXXXXXXX' },
  },
  {
    id: 'ai',
    name: 'AI Assistant (Claude)',
    icon: '✨',
    blurb: 'Powers the Command Center assistant + AI root-cause analysis (Anthropic Claude).',
    fieldProviders: ['ai'],
    ownKeys: ['ANTHROPIC_API_KEY'],
  },
];

const byId = (id: string) => PROVIDERS.find((p) => p.id === id)!;

/** A provider is "connected" when every own key is set. */
function isConnected(p: Provider, fields: IntegrationField[]): boolean {
  const set = new Set(fields.filter((f) => f.set).map((f) => f.key));
  return p.ownKeys.every((k) => set.has(k));
}
/** "Added" = builtin, or at least one own key has a value. */
function isAdded(p: Provider, fields: IntegrationField[]): boolean {
  if (p.builtin) return true;
  const set = new Set(fields.filter((f) => f.set).map((f) => f.key));
  return p.ownKeys.some((k) => set.has(k));
}

export function IntegrationsCard() {
  const cfg = useIntegrations();
  const remove = useRemoveIntegration();
  const test = useTestIntegration();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const health = useIntegrationsHealth();
  const runHealth = useRunIntegrationHealth();
  const healthMap = Object.fromEntries((health.data ?? []).map((h) => [h.provider, h]));

  const fields = cfg.data ?? [];
  const added = PROVIDERS.filter((p) => isAdded(p, fields));
  const available = PROVIDERS.filter((p) => !isAdded(p, fields));

  const onRemove = async (p: Provider) => {
    if (!confirm(`Remove the ${p.name} integration? Its saved credentials will be deleted.`)) return;
    setMsg(null);
    try {
      await remove.mutateAsync(p.id);
      setMsg(`${p.name} removed.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  // Per-integration Test — works on saved integrations (and after editing). Shows WHY it fails.
  const runTest = async (p: Provider) => {
    let to: string | undefined;
    if (p.testTarget) {
      const v = window.prompt(p.testTarget.label, '');
      if (v == null) return; // cancelled
      to = v.trim() || undefined;
    }
    setTesting(p.id);
    setResults((r) => { const n = { ...r }; delete n[p.id]; return n; });
    try {
      const r = await test.mutateAsync({ provider: p.id, to });
      setResults((res) => ({ ...res, [p.id]: { ok: true, text: r.detail } }));
    } catch (e) {
      setResults((res) => ({ ...res, [p.id]: { ok: false, text: (e as Error).message } }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <Card
      title="Integrations"
      className="col-span-12"
      action={
        <div className="flex items-center gap-2">
          <button onClick={() => runHealth.mutate()} disabled={runHealth.isPending} title="Test every integration now (also runs automatically every hour)" className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-brand hover:text-white disabled:opacity-50">{runHealth.isPending ? 'Testing all…' : '↻ Test all'}</button>
          <button onClick={() => setAdding(true)} disabled={available.length === 0} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-40">
            + Add Integration
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        {msg && <div className="rounded-lg border border-border bg-card/60 px-3 py-2 text-2xs text-muted-light">{msg}</div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {added.map((p) => {
            const connected = isConnected(p, fields);
            return (
              <div key={p.id} className="flex flex-col rounded-xl border border-border bg-card/50 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-bg text-lg">{p.icon}</span>
                    <div>
                      <div className="text-xs font-semibold text-white">{p.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs ${connected ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
                          {connected ? 'Connected' : 'Needs setup'}
                        </span>
                        {healthMap[p.id] && (
                          <span className={`rounded px-1.5 py-0.5 text-2xs ${healthMap[p.id].ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`} title={`${healthMap[p.id].detail} · checked ${timeAgo(healthMap[p.id].at)}`}>
                            {healthMap[p.id].ok ? '✓ healthy' : '✕ failing'} · {timeAgo(healthMap[p.id].at)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {p.builtin && <span className="rounded bg-brand/15 px-1.5 py-0.5 text-2xs text-brand">Default</span>}
                </div>
                <div className="mt-2 flex-1 text-2xs text-muted">{p.blurb}</div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => setEditing(p.id)} className="rounded-lg bg-brand/90 px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand">Edit</button>
                  <button onClick={() => runTest(p)} disabled={testing === p.id} className="rounded-lg border border-border bg-card px-2.5 py-1 text-2xs text-brand hover:text-white disabled:opacity-50">{testing === p.id ? 'Testing…' : 'Test'}</button>
                  {!p.builtin && (
                    <button onClick={() => onRemove(p)} className="rounded-lg border border-border bg-card px-2.5 py-1 text-2xs text-danger hover:text-white">Remove</button>
                  )}
                </div>
                {results[p.id] && (
                  <div className={`mt-2 rounded-lg border px-2 py-1 text-2xs ${results[p.id].ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>
                    {results[p.id].ok ? '✓ ' : '✕ Test failed — '}{results[p.id].text}
                  </div>
                )}
                {!results[p.id] && healthMap[p.id] && !healthMap[p.id].ok && (
                  <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">✕ Hourly check failed — {healthMap[p.id].detail}</div>
                )}
              </div>
            );
          })}
        </div>
        <div className="text-2xs text-muted">Secrets are encrypted at rest and never shown back. Integrations activate the moment valid credentials are saved.</div>
      </div>

      {adding && (
        <AddIntegrationModal
          available={available}
          onPick={(id) => { setAdding(false); setEditing(id); }}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <IntegrationEditor provider={byId(editing)} fields={fields} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

function AddIntegrationModal({ available, onPick, onClose }: { available: Provider[]; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <Modal title="Add Integration" subtitle="Choose a service to connect" onClose={onClose}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {available.map((p) => (
          <button key={p.id} onClick={() => onPick(p.id)} className="flex items-start gap-3 rounded-xl border border-border bg-card/50 p-3 text-left hover:border-brand/50 hover:bg-card-hover">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-bg text-lg">{p.icon}</span>
            <span>
              <span className="block text-xs font-semibold text-white">{p.name}</span>
              <span className="block text-2xs text-muted">{p.blurb}</span>
            </span>
          </button>
        ))}
        {available.length === 0 && <div className="col-span-2 py-6 text-center text-2xs text-muted">All available integrations are already added.</div>}
      </div>
    </Modal>
  );
}

function IntegrationEditor({ provider, fields, onClose }: { provider: Provider; fields: IntegrationField[]; onClose: () => void }) {
  const update = useUpdateIntegrations();
  const test = useTestIntegration();
  const myFields = useMemo(
    () => provider.fieldProviders.flatMap((fp) => fields.filter((f) => f.provider === fp)),
    [provider, fields],
  );
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const d: Record<string, string> = {};
    for (const f of myFields) if (!f.secret) d[f.key] = f.value ?? '';
    setDraft(d);
  }, [myFields]);

  const set = (k: string, v: string) => setDraft((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setMsg(null);
    const patch: Record<string, string> = {};
    for (const f of myFields) {
      if (f.secret) { if (draft[f.key]) patch[f.key] = draft[f.key]; }
      else patch[f.key] = draft[f.key] ?? '';
    }
    try {
      await update.mutateAsync(patch);
      setMsg({ ok: true, text: 'Saved — applied immediately.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const runTest = async () => {
    setMsg(null);
    try {
      // Save first so the test uses the latest values.
      await save();
      const r = await test.mutateAsync({ provider: provider.id, to: target || undefined });
      setMsg({ ok: true, text: r.detail });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <Modal title={`${provider.icon}  ${provider.name}`} subtitle={provider.blurb} onClose={onClose}>
      <div className="space-y-3">
        {msg && (
          <div className={`rounded-lg border px-3 py-2 text-2xs ${msg.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>{msg.text}</div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {myFields.map((f) => (
            <label key={f.key} className={`block ${f.secret || f.key === 'SSO_BASE_URL' ? 'sm:col-span-2' : ''}`}>
              <span className="mb-1 flex items-center gap-2 text-2xs font-medium text-muted">
                {f.label}
                {f.secret && <span className={`rounded px-1 text-2xs ${f.set ? 'bg-success/15 text-success' : 'bg-border/40 text-muted'}`}>{f.set ? 'set' : 'not set'}</span>}
              </span>
              {f.secret ? (
                <PasswordInput
                  value={draft[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.set ? '•••••••• (leave blank to keep)' : f.hint || 'enter value'}
                  autoComplete="off"
                  className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none"
                />
              ) : (
                <input
                  type="text"
                  value={draft[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.hint}
                  className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none"
                />
              )}
            </label>
          ))}
        </div>

        {provider.testTarget && (
          <label className="block">
            <span className="mb-1 block text-2xs font-medium text-muted">{provider.testTarget.label}</span>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={provider.testTarget.placeholder}
              className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
          </label>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <button onClick={runTest} disabled={test.isPending || update.isPending} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-brand hover:text-white disabled:opacity-50">
            {test.isPending ? 'Testing…' : provider.testTarget ? 'Save & send test' : 'Save & validate'}
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Close</button>
            <button onClick={save} disabled={update.isPending} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const STATUS_STYLE: Record<string, string> = {
  sent: 'bg-success/15 text-success',
  failed: 'bg-danger/15 text-danger',
  gave_up: 'bg-muted/20 text-muted',
};

const RETENTION_PRESETS: [number, string][] = [
  [30, '30 days'],
  [90, '3 months'],
  [180, '6 months'],
  [365, '1 year'],
  [730, '2 years'],
];

/** Compliance retention editor for the delivery log — preset windows + a custom days value. */
function RetentionControl() {
  const { data } = useSettings();
  const update = useUpdateSettings();
  const current = data?.logRetentionDays ?? 90;
  const [custom, setCustom] = useState('');
  useEffect(() => setCustom(String(current)), [current]);
  const isPreset = RETENTION_PRESETS.some(([d]) => d === current);
  const save = (n: number) => {
    const v = Math.max(7, Math.min(3650, Math.round(n) || 90));
    setCustom(String(v));
    if (v !== current) update.mutate({ logRetentionDays: v });
  };
  return (
    <span className="flex items-center gap-1.5 text-2xs text-muted">
      <span className="text-muted-light">Keep logs</span>
      <select
        value={isPreset ? String(current) : 'custom'}
        onChange={(e) => e.target.value !== 'custom' && save(Number(e.target.value))}
        className="rounded-md border border-border bg-bg px-1.5 py-0.5 text-2xs text-white focus:border-brand focus:outline-none"
      >
        {RETENTION_PRESETS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {!isPreset && (
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={7}
            max={3650}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onBlur={() => save(Number(custom))}
            onKeyDown={(e) => e.key === 'Enter' && save(Number(custom))}
            className="w-14 rounded-md border border-border bg-bg px-1.5 py-0.5 text-2xs text-white focus:border-brand focus:outline-none"
          />
          <span>days</span>
        </span>
      )}
      {update.isPending ? <span className="text-muted">…</span> : update.isSuccess && <span className="text-success">✓</span>}
    </span>
  );
}

export function DeliveryLogCard() {
  const del = useDeliveries();
  const retry = useRetryDelivery();
  const remove = useDeleteDelivery();
  const failed = (del.data ?? []).filter((d) => d.status === 'failed').length;
  return (
    <Card
      title={`Notification Delivery Log${failed > 0 ? ` · ${failed} failed` : ''}`}
      className="col-span-12 lg:col-span-6"
      bodyClassName="p-0"
      action={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="hidden text-2xs text-muted lg:block">Auto-retry: 3× every 3 min, then hourly · stops after 3 days</span>
          <RetentionControl />
        </div>
      }
    >
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Channel</th>
              <th className="px-4 py-2 font-medium">To</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Detail / error</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {del.data?.map((d) => (
              <tr key={d.id} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2 text-2xs text-muted" title={new Date(d.ts).toLocaleString()}>{timeAgo(d.ts)}</td>
                <td className="px-4 py-2 text-2xs text-white">{d.channelName} <span className="text-muted">({d.channelType})</span></td>
                <td className="px-4 py-2 font-mono text-2xs text-muted-light">{d.target}</td>
                <td className="px-4 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-2xs ${STATUS_STYLE[d.status] ?? 'bg-warning/15 text-warning'}`}>{d.status === 'gave_up' ? 'gave up' : d.status}</span>
                  {d.attempts > 1 && <span className="ml-1 text-2xs text-muted" title={`${d.attempts} attempts`}>×{d.attempts}</span>}
                  {d.status === 'failed' && d.nextRetryAt && <div className="text-2xs text-muted">retry {timeAgo(d.nextRetryAt)}</div>}
                </td>
                <td className="px-4 py-2 text-2xs"><span className={d.status === 'sent' ? 'text-muted' : 'text-danger'}>{d.error ?? d.subject}</span></td>
                <td className="px-4 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => retry.mutate(d.id)}
                      disabled={!d.canRetry || retry.isPending}
                      title={d.canRetry ? 'Re-send now' : 'No saved message to retry (legacy entry)'}
                      className="rounded border border-border bg-card px-2 py-0.5 text-2xs text-brand hover:text-white disabled:opacity-40"
                    >
                      ↻ Retry
                    </button>
                    <button onClick={() => remove.mutate(d.id)} disabled={remove.isPending} className="text-2xs text-danger hover:underline disabled:opacity-40" title="Delete this log entry">✕</button>
                  </div>
                </td>
              </tr>
            ))}
            {del.data?.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-2xs text-muted">No notifications sent yet. Add a channel and use “Test”.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
