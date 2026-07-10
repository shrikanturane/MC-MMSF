'use client';

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface EnvVar { key: string; label: string; group: 'infra' | 'secret'; secret: boolean; set: boolean; value: string }

export function EnvironmentPanel() {
  const env = useQuery({ queryKey: ['environment'], queryFn: () => apiGet<EnvVar[]>('/settings/environment') });
  const [revealed, setRevealed] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (env.isError) return null; // non-admin
  const rows = env.data ?? [];
  const infra = rows.filter((r) => r.group === 'infra');
  const secrets = rows.filter((r) => r.group === 'secret');

  const reveal = async () => {
    const code = window.prompt('Maker-checker secrets are 2FA-protected.\nEnter a fresh 6-digit code from your authenticator to reveal the secret values:');
    if (!code) return;
    setBusy(true); setErr(null);
    try {
      const r = await apiPost<{ key: string; value: string }[]>('/settings/environment/reveal', { code: code.trim() });
      const map: Record<string, string> = {}; r.forEach((x) => (map[x.key] = x.value));
      setRevealed(map);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const cell = (v: EnvVar) => {
    if (!v.set) return <span className="text-muted-light">(not set)</span>;
    if (v.secret && revealed?.[v.key] !== undefined) return <span className="break-all font-mono text-emerald-300">{revealed[v.key] || '(empty)'}</span>;
    return <span className="break-all font-mono text-white">{v.value}</span>;
  };

  return (
    <Card title="Environment & Secrets" className="col-span-12"
      action={<button onClick={reveal} disabled={busy} className={`rounded-md px-3 py-1.5 text-2xs font-medium ${revealed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'} disabled:opacity-50`}>{busy ? 'Verifying…' : revealed ? '🔓 Secrets revealed' : '🔒 Reveal secrets (2FA)'}</button>}>
      <div className="border-b border-border px-4 py-2 text-2xs text-muted">
        Deploy-time configuration, surfaced for admins. <b className="text-white">Infra</b> values are shown for visibility; <b className="text-white">secrets</b> are masked and revealed only after a fresh <b className="text-white">2FA</b> code. These are env-managed — to change one, update the server&apos;s <code className="text-muted-light">.env</code> and restart (editable secrets like SMTP / SSO / AI live in <b className="text-white">Settings → Integrations</b>).
      </div>
      {err && <div className="mx-4 mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}
      <div className="space-y-4 p-4">
        <Section title="Infrastructure (bootstrap)" vars={infra} cell={cell} />
        <Section title="Secrets (2FA to reveal)" vars={secrets} cell={cell} />
      </div>
    </Card>
  );
}

function Section({ title, vars, cell }: { title: string; vars: EnvVar[]; cell: (v: EnvVar) => ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border bg-card-hover/40 px-3 py-1.5 text-2xs font-semibold text-white">{title}</div>
      <table className="w-full text-2xs">
        <tbody className="divide-y divide-border-soft">
          {vars.map((v) => (
            <tr key={v.key}>
              <td className="px-3 py-1.5 align-top"><div className="font-medium text-white">{v.label}</div><div className="font-mono text-muted-light">{v.key}</div></td>
              <td className="px-3 py-1.5 text-right align-top">{!v.set ? <span className="rounded bg-border/40 px-1.5 text-muted">unset</span> : <span className="rounded bg-emerald-500/15 px-1.5 text-emerald-300">set</span>}</td>
              <td className="w-1/2 px-3 py-1.5 align-top">{cell(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
