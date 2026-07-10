'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import { timeAgo } from '@/lib/format';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/lib/hooks';

/** Open-API key management for 3rd-party ITSM & monitoring integrations. */
export function ApiKeysCard() {
  const { data: keys } = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read', 'alerts']);
  const [issued, setIssued] = useState<string | null>(null);
  const base = typeof window !== 'undefined' ? `${window.location.origin}/api/v1` : '/api/v1';

  const add = async () => {
    if (!name.trim()) return;
    try { const r = await create.mutateAsync({ name: name.trim(), scopes }); setIssued(r.key); setName(''); } catch { /* surfaced below */ }
  };
  const toggle = (s: string) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <Card title="API Keys — Open Integration API" className="col-span-12" bodyClassName="p-3 space-y-3">
      <div className="text-2xs text-muted">
        Read-only REST API for 3rd-party tools to pull <b className="text-white">all monitoring data</b> — IP/Host monitors, network devices, guest agents and active alerts (ITSM incident source). Authenticate with the header <span className="font-mono text-white">x-api-key: mcmf_…</span>.
        <div className="mt-1.5 rounded-lg border border-border bg-bg p-2 font-mono text-[10px] leading-relaxed text-muted-light">
          <div>GET <span className="text-white">{base}/monitors</span>?group=&lt;scope&gt;&amp;kind=host|device|agent</div>
          <div>GET <span className="text-white">{base}/devices</span> · /agents · /alerts · /summary</div>
          <div className="mt-1 text-muted">curl -H &quot;x-api-key: mcmf_…&quot; {base}/summary</div>
        </div>
      </div>

      {/* Create */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-bg/40 p-2.5">
        <div className="min-w-[180px] flex-1">
          <label className="mb-1 block text-2xs text-muted">Key name (the tool you&apos;re connecting)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ServiceNow, Datadog, Grafana" className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          {['read', 'alerts'].map((s) => (
            <label key={s} className="flex items-center gap-1"><input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} /> {s}</label>
          ))}
        </div>
        <button onClick={add} disabled={create.isPending || !name.trim()} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50">Generate key</button>
      </div>

      {/* One-time secret reveal */}
      {issued && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-2xs">
          <div className="mb-1 font-semibold text-emerald-300">Copy this key now — it&apos;s shown only once:</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-bg px-2 py-1 font-mono text-white">{issued}</code>
            <button onClick={() => { navigator.clipboard?.writeText(issued); }} className="rounded border border-border bg-card px-2 py-1 text-brand hover:text-white">Copy</button>
            <button onClick={() => setIssued(null)} className="rounded border border-border bg-card px-2 py-1 text-muted hover:text-white">Done</button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-2xs">
          <thead><tr className="border-b border-border text-left text-muted"><th className="px-3 py-1.5 font-medium">Name</th><th className="px-3 py-1.5 font-medium">Key</th><th className="px-3 py-1.5 font-medium">Scopes</th><th className="px-3 py-1.5 font-medium">Last used</th><th className="px-3 py-1.5"></th></tr></thead>
          <tbody>
            {(keys ?? []).filter((k) => !k.revokedAt).length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-4 text-center text-muted">No API keys yet. Generate one above to connect an ITSM or monitoring tool.</td></tr>
            ) : (keys ?? []).filter((k) => !k.revokedAt).map((k) => (
              <tr key={k.id} className="border-t border-border-soft">
                <td className="px-3 py-1.5 text-white">{k.name}</td>
                <td className="px-3 py-1.5 font-mono text-muted-light">{k.prefix}…</td>
                <td className="px-3 py-1.5 text-muted-light">{k.scopes.join(', ')}</td>
                <td className="px-3 py-1.5 text-muted">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}</td>
                <td className="px-3 py-1.5 text-right"><button onClick={() => confirm(`Revoke API key "${k.name}"? Tools using it will stop working immediately.`) && revoke.mutate(k.id)} className="rounded border border-border bg-card px-1.5 py-0.5 text-muted hover:text-danger">Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
