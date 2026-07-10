'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Card, LoadingState, Modal } from '@/components/ui';
import { PasswordInput } from '@/components/PasswordInput';
import {
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useProviderSpecs,
  useSyncConnection,
  useTestConnection,
  useUpdateConnection,
} from '@/lib/hooks';
import { PROVIDER_COLORS, PROVIDER_LABELS, STATUS_COLORS, timeAgo, type Provider } from '@/lib/format';
import type { CloudConnection, ProviderField, ProviderSpec, TestResult } from '@/lib/types';

export function ConnectionsView() {
  const connections = useConnections();
  const specs = useProviderSpecs();
  const create = useCreateConnection();
  const test = useTestConnection();
  const sync = useSyncConnection();
  const del = useDeleteConnection();

  const [showForm, setShowForm] = useState(false);
  const [provider, setProvider] = useState<string>('azure');
  const [name, setName] = useState('');
  const [creds, setCreds] = useState<Record<string, string>>({});

  const [testResult, setTestResult] = useState<{ id: string; result: TestResult } | null>(null);
  const [syncMsg, setSyncMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [editConn, setEditConn] = useState<CloudConnection | null>(null);

  const activeSpec = specs.data?.find((s) => s.provider === provider);

  const submit = async () => {
    setTestResult(null);
    setSyncMsg(null);
    const created = await create.mutateAsync({ name: name || `${PROVIDER_LABELS[provider as Provider]} connection`, provider, credentials: creds });
    setShowForm(false);
    setName('');
    setCreds({});
    const result = await test.mutateAsync(created.id);
    setTestResult({ id: created.id, result });
  };

  const runTest = async (id: string) => {
    setSyncMsg(null);
    setTestResult(null);
    try {
      const result = await test.mutateAsync(id);
      setTestResult({ id, result });
    } catch (e) {
      setTestResult({ id, result: { ok: false, detail: (e as Error).message, stages: [{ name: 'Request', ok: false, detail: (e as Error).message }] } });
    }
  };

  const runSync = async (id: string) => {
    setTestResult(null);
    setSyncMsg(null);
    try {
      const r = await sync.mutateAsync(id);
      setSyncMsg({ id, text: `Discovered ${r.discovered} resources into "${r.account}"`, ok: true });
    } catch (e) {
      setSyncMsg({ id, text: (e as Error).message, ok: false });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">Cloud Connections</div>
          <div className="text-2xs text-muted">
            Connect real AWS, Azure, GCP, Docker and SSH hosts. Test (see each phase), then Sync to discover live resources.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/help" className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">
            Integration Guide
          </Link>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft"
          >
            {showForm ? 'Cancel' : '+ Add Connection'}
          </button>
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <Card title="New Connection">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider">
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setCreds({});
                }}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
              >
                {specs.data?.map((s) => (
                  <option key={s.provider} value={s.provider}>
                    {PROVIDER_LABELS[s.provider as Provider]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Connection Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Production"
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none"
              />
            </Field>
            {activeSpec?.fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.optional ? '' : ' *'}`} className={f.multiline ? 'sm:col-span-2' : ''}>
                <CredInput field={f} value={creds[f.key] ?? ''} onChange={(v) => setCreds({ ...creds, [f.key]: v })} />
              </Field>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={submit}
              disabled={create.isPending || test.isPending}
              className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:bg-brand-soft"
            >
              {create.isPending || test.isPending ? 'Saving & testing…' : 'Save & Test'}
            </button>
            <Link href="/help" className="text-2xs text-brand hover:underline">
              Need credentials? See the Integration Guide →
            </Link>
          </div>
        </Card>
      )}

      {/* Connections list */}
      {connections.isLoading ? (
        <LoadingState rows={3} />
      ) : connections.data && connections.data.length > 0 ? (
        <div className="grid gap-3">
          {connections.data.map((c) => (
            <div key={c.id} className="card card-pad border-l-[3px]" style={{ borderLeftColor: STATUS_COLORS[c.status] ?? '#64748b' }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-2xs font-bold text-white"
                    style={{ background: PROVIDER_COLORS[c.provider] }}
                  >
                    {PROVIDER_LABELS[c.provider].slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{c.name}</span>
                      <Badge color={STATUS_COLORS[c.status] ?? '#64748b'} tone="dot">{c.status}</Badge>
                    </div>
                    <div className="text-2xs text-muted">
                      {PROVIDER_LABELS[c.provider]} · {c.accountRef || 'no account ref'} · {c.assetsFound} assets ·{' '}
                      {c.lastSyncAt ? `synced ${timeAgo(c.lastSyncAt)}` : 'never synced'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => runTest(c.id)}
                    disabled={test.isPending}
                    className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white disabled:opacity-50"
                  >
                    {test.isPending && testResult?.id !== c.id ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    onClick={() => runSync(c.id)}
                    disabled={sync.isPending}
                    className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50"
                  >
                    {sync.isPending ? 'Syncing…' : 'Sync'}
                  </button>
                  <button
                    onClick={() => {
                      setTestResult(null);
                      setSyncMsg(null);
                      setEditConn(c);
                    }}
                    className="rounded-lg border border-brand/30 bg-brand/10 px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/20"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => del.mutate(c.id)}
                    className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger hover:bg-danger/20"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Phased test result */}
              {testResult?.id === c.id && <TestStages result={testResult.result} />}

              {/* Sync / last-error feedback */}
              {syncMsg?.id === c.id && (
                <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${syncMsg.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>
                  {syncMsg.text}
                </div>
              )}
              {!testResult && !syncMsg && c.lastSyncError && (
                <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  Last error: {c.lastSyncError}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Card>
          <div className="py-10 text-center">
            <div className="text-sm font-medium text-white">No cloud connections yet</div>
            <div className="mx-auto mt-1 max-w-md text-xs text-muted">
              Add a connection with real credentials, hit Test, then Sync. Need help? See the{' '}
              <Link href="/help" className="text-brand hover:underline">Integration Guide</Link>.
            </div>
            <button onClick={() => setShowForm(true)} className="mt-4 rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">
              + Add your first connection
            </button>
          </div>
        </Card>
      )}

      {/* Edit modal */}
      {editConn && specs.data && (
        <EditConnectionModal
          conn={editConn}
          spec={specs.data.find((s) => s.provider === editConn.provider)}
          onClose={() => setEditConn(null)}
          onSaved={(result) => {
            setEditConn(null);
            if (result) setTestResult({ id: editConn.id, result });
          }}
        />
      )}
    </div>
  );
}

function TestStages({ result }: { result: TestResult }) {
  return (
    <div className={`mt-3 rounded-lg border p-3 ${result.ok ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}`}>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        <span style={{ color: result.ok ? '#22c55e' : '#ef4444' }}>{result.ok ? '✓ Connection OK' : '✕ Test failed'}</span>
        <span className="text-muted">— {result.detail}</span>
      </div>
      <ol className="space-y-1.5">
        {result.stages.map((s, i) => {
          const warn = !s.ok && !s.skipped && s.optional;
          return (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 w-4 text-center">
                {s.skipped ? (
                  <span className="text-muted">○</span>
                ) : s.ok ? (
                  <span className="text-success">✓</span>
                ) : warn ? (
                  <span className="text-warning">⚠</span>
                ) : (
                  <span className="text-danger">✕</span>
                )}
              </span>
              <span className="min-w-0">
                <span className={s.skipped ? 'text-muted' : 'text-white'}>
                  {s.name}
                  {warn && <span className="ml-1 text-2xs text-warning">(optional)</span>}
                </span>
                <span className="ml-2 break-words text-2xs text-muted">{s.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EditConnectionModal({
  conn,
  spec,
  onClose,
  onSaved,
}: {
  conn: CloudConnection;
  spec?: ProviderSpec;
  onClose: () => void;
  onSaved: (result: TestResult | null) => void;
}) {
  const update = useUpdateConnection();
  const test = useTestConnection();
  const [name, setName] = useState(conn.name);
  const [creds, setCreds] = useState<Record<string, string>>({});

  const save = async () => {
    await update.mutateAsync({ id: conn.id, name, credentials: creds });
    try {
      const result = await test.mutateAsync(conn.id);
      onSaved(result);
    } catch {
      onSaved(null);
    }
  };

  const busy = update.isPending || test.isPending;

  return (
    <Modal title="Edit Connection" subtitle={`${PROVIDER_LABELS[conn.provider]} · ${conn.accountRef || conn.id}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Connection Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
          />
        </Field>
        <div className="rounded-lg border border-border bg-bg/40 p-3">
          <div className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted">Credentials</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {spec?.fields.map((f) => (
              <Field key={f.key} label={f.label} className={f.multiline ? 'sm:col-span-2' : ''}>
                <CredInput field={f} value={creds[f.key] ?? ''} onChange={(v) => setCreds({ ...creds, [f.key]: v })} editMode />
              </Field>
            ))}
          </div>
          <div className="mt-2 text-2xs text-muted">Only fields you fill in are updated. Saving re-runs the connection test.</div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:bg-brand-soft">
            {busy ? 'Saving…' : 'Save & Test'}
          </button>
        </div>
      </div>
    </Modal>
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

function CredInput({
  field,
  value,
  onChange,
  editMode = false,
}: {
  field: ProviderField;
  value: string;
  onChange: (v: string) => void;
  editMode?: boolean;
}) {
  if (field.multiline) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={7}
        spellCheck={false}
        autoComplete="off"
        placeholder={editMode ? 'leave blank to keep current key' : '{\n  "type": "service_account",\n  "project_id": "...",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\n..."\n}'}
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-2xs text-white placeholder:text-muted/50 focus:border-brand focus:outline-none"
      />
    );
  }
  const fieldCls = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted/60 focus:border-brand focus:outline-none';
  if (field.secret) {
    return <PasswordInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={editMode ? 'leave blank to keep current' : undefined} autoComplete="off" className={fieldCls} />;
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={editMode ? 'leave blank to keep current' : undefined}
      autoComplete="off"
      className={fieldCls}
    />
  );
}
