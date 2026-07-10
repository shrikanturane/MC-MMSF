'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { PasswordInput } from '@/components/PasswordInput';
import { useVault, useRevealCredential, useUpsertCredential, useUpdateCredential, useDeleteCredential, type VaultEntry } from '@/lib/hooks';
import { copyText } from '@/lib/clipboard';
import { timeAgo } from '@/lib/format';

const KIND_META: Record<string, { icon: string; color: string }> = {
  vm: { icon: '🖥', color: '#3b82f6' },
  firewall: { icon: '🛡', color: '#ef4444' },
  router: { icon: '📡', color: '#a855f7' },
  switch: { icon: '🔀', color: '#06b6d4' },
  network: { icon: '🌐', color: '#22c55e' },
  other: { icon: '🔑', color: '#64748b' },
};
const KINDS = ['vm', 'firewall', 'router', 'switch', 'network', 'other'];
const PROTOCOLS = ['ssh', 'rdp', 'telnet', 'vnc', 'snmp', 'https', 'other'];
const inputCls = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none';

/** Per-user encrypted credential vault. Passwords are revealed only after a 2FA code — every time. */
export function CredentialVault() {
  const vault = useVault();
  const reveal = useRevealCredential();
  const upsert = useUpsertCredential();
  const update = useUpdateCredential();
  const del = useDeleteCredential();
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const empty = { host: '', protocol: 'ssh', protocols: ['ssh'] as string[], username: '', password: '', kind: 'vm', label: '' };
  const [f, setF] = useState(empty);
  const toggleProto = (p: string) => setF((cur) => ({ ...cur, protocols: cur.protocols.includes(p) ? cur.protocols.filter((x) => x !== p) : [...cur.protocols, p] }));
  const [q, setQ] = useState('');

  // Multi-select + reveal state.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState<string[] | null>(null); // ids awaiting a 2FA code
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // Auto-hide ALL revealed passwords after 30s.
  useEffect(() => {
    if (Object.keys(revealed).length === 0) return;
    const t = setTimeout(() => setRevealed({}), 30000);
    return () => clearTimeout(t);
  }, [revealed]);

  const rows = (vault.data ?? []).filter((r) => {
    const t = q.toLowerCase();
    return !t || r.host.toLowerCase().includes(t) || r.username.toLowerCase().includes(t) || r.label.toLowerCase().includes(t) || r.kind.includes(t);
  });

  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = rows.length > 0 && rows.every((r) => sel.has(r.id));

  // Every "View password" click opens the 2FA prompt — the user's current TOTP code is required each time.
  const askView = (ids: string[]) => { if (!ids.length) return; setPrompt(ids); setCode(''); setErr(null); };
  const doReveal = async () => {
    if (!prompt) return;
    setErr(null);
    try {
      const out: Record<string, string> = {};
      for (const id of prompt) { const res = await reveal.mutateAsync({ id, code: code.replace(/\s/g, '') }); out[id] = res.password; }
      setRevealed((r) => ({ ...r, ...out }));
      setPrompt(null); setCode(''); setSel(new Set());
    } catch (e) { setErr((e as Error).message); }
  };

  const openNew = () => { setEditId(null); setF(empty); setAdding(true); };
  const startEdit = (r: VaultEntry) => { setEditId(r.id); setF({ host: r.host, protocol: r.protocol, protocols: [r.protocol], username: r.username, password: '', kind: r.kind, label: r.label }); setAdding(true); };
  const save = () => {
    if (editId) update.mutate({ id: editId, host: f.host, protocol: f.protocol, username: f.username, password: f.password, kind: f.kind, label: f.label });
    else upsert.mutate({ host: f.host, protocols: f.protocols, username: f.username, password: f.password, kind: f.kind, label: f.label });
    setAdding(false);
  };

  return (
    <Card
      title="Credential Vault"
      className="col-span-12"
      bodyClassName="p-0"
      action={
        <div className="flex items-center gap-3">
          {sel.size > 0 && <button onClick={() => askView([...sel])} className="rounded-md border border-brand/40 bg-brand/10 px-2.5 py-1 text-2xs font-medium text-brand hover:bg-brand/20">👁 View password ({sel.size})</button>}
          <span className="hidden text-2xs text-muted lg:block">🔒 AES-256-GCM · 2FA each view</span>
          <button onClick={() => (adding ? setAdding(false) : openNew())} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">{adding ? 'Close' : '+ Add credential'}</button>
        </div>
      }
    >
      {adding && (
        <div className="space-y-2 border-b border-border bg-brand/[0.04] p-3">
          {editId && <div className="text-2xs font-semibold text-brand">✎ Editing credential</div>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="Host / IP" className={inputCls} />
            <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Label (optional)" className={inputCls} />
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className={inputCls}>{KINDS.map((k) => <option key={k} value={k}>{KIND_META[k]?.icon} {k}</option>)}</select>
            {editId ? (
              <select value={f.protocol} onChange={(e) => setF({ ...f, protocol: e.target.value })} className={inputCls}>{PROTOCOLS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}</select>
            ) : <div className="hidden sm:block" />}
            <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="Username" autoComplete="off" className={inputCls} />
            <PasswordInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder={editId ? 'Password (blank = keep)' : 'Password'} autoComplete="new-password" className={inputCls} />
          </div>
          {!editId && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card/40 px-2 py-1.5 text-2xs">
              <span className="text-muted">Services (same password):</span>
              {PROTOCOLS.map((p) => (
                <label key={p} className="flex items-center gap-1 text-white"><input type="checkbox" checked={f.protocols.includes(p)} onChange={() => toggleProto(p)} /> {p.toUpperCase()}</label>
              ))}
            </div>
          )}
          <button onClick={save} disabled={upsert.isPending || update.isPending || !f.host || !f.username || (!editId && !f.password)} className="rounded-md bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{editId ? 'Save changes' : 'Add to vault'}</button>
        </div>
      )}

      {/* 2FA prompt — appears on every View-password click */}
      {prompt && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2">
          <span className="text-2xs text-warning">🔐 Enter your current 2FA code to view {prompt.length} password{prompt.length > 1 ? 's' : ''}:</span>
          <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doReveal()} placeholder="6-digit code" inputMode="numeric" maxLength={8} className="w-24 rounded border border-border bg-bg px-2 py-1 text-center font-mono text-2xs text-white focus:border-brand focus:outline-none" />
          <button onClick={doReveal} disabled={reveal.isPending || code.replace(/\s/g, '').length < 6} className="rounded bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{reveal.isPending ? 'Verifying…' : 'View'}</button>
          <button onClick={() => { setPrompt(null); setCode(''); }} className="text-2xs text-muted hover:text-white">Cancel</button>
          {err && <span className="text-2xs text-danger">{err}</span>}
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <label className="flex items-center gap-1.5 text-2xs text-muted">
          <input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /> select all
        </label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search host / user / label…" className="w-52 rounded-md border border-border bg-bg px-2.5 py-1 text-2xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        <span className="ml-auto text-2xs text-muted">{rows.length} credential(s){sel.size ? ` · ${sel.size} selected` : ''}</span>
      </div>

      <div className="max-h-[28rem] overflow-auto">
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-2xs text-muted">Your vault is empty. Console saves, SSH-pull enrollments, and entries you add here all live in your personal vault.</div>
        ) : (
          rows.map((r) => (
            <VaultRow
              key={r.id}
              r={r}
              selected={sel.has(r.id)}
              onToggle={() => toggleSel(r.id)}
              password={revealed[r.id]}
              onView={() => askView([r.id])}
              onHide={() => setRevealed((m) => { const n = { ...m }; delete n[r.id]; return n; })}
              onEdit={() => startEdit(r)}
              onDelete={() => del.mutate(r.id)}
            />
          ))
        )}
      </div>
    </Card>
  );
}

function VaultRow({ r, selected, onToggle, password, onView, onHide, onEdit, onDelete }: {
  r: VaultEntry; selected: boolean; onToggle: () => void; password?: string; onView: () => void; onHide: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const meta = KIND_META[r.kind] ?? KIND_META.other;
  return (
    <div className="border-b border-border-soft px-4 py-2.5 last:border-0">
      <div className="flex items-center gap-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="shrink-0" />
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base" style={{ background: `${meta.color}1f`, color: meta.color }}>{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-white">{r.label || r.host}</span>
            <span className="rounded px-1.5 py-0.5 text-2xs font-medium" style={{ background: `${meta.color}1f`, color: meta.color }}>{r.kind}</span>
            <span className="rounded bg-card-hover px-1.5 py-0.5 text-2xs text-muted-light">{r.protocol}</span>
          </div>
          <div className="truncate font-mono text-2xs text-muted">{r.username}@{r.host} · updated {timeAgo(r.updatedAt)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!password && <button onClick={onView} className="rounded-md border border-border bg-card px-2 py-0.5 text-2xs text-brand hover:bg-card-hover hover:text-white">👁 View password</button>}
          <button onClick={onEdit} className="text-2xs text-muted hover:text-white" title="Edit">✎</button>
          <button onClick={() => confirm(`Delete credential for ${r.host}?`) && onDelete()} className="text-2xs text-danger hover:underline" title="Delete">✕</button>
        </div>
      </div>
      {password && (
        <div className="ml-12 mt-2 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-2 py-1.5">
          <span className="text-2xs text-muted">Password:</span>
          <span className="flex-1 truncate font-mono text-xs text-white">{password}</span>
          <button onClick={() => copyText(password)} className="rounded border border-border bg-card px-2 py-0.5 text-2xs text-brand hover:text-white">Copy</button>
          <button onClick={onHide} className="text-2xs text-muted hover:text-white">Hide</button>
          <span className="text-2xs text-muted">auto-hides 30s</span>
        </div>
      )}
    </div>
  );
}
