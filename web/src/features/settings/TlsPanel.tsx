'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui';
import { useTlsStatus, useRegenerateTls, useDownloadCert, useDownloadCertInstaller } from '@/lib/hooks';

/** TLS / certificate management — status, regenerate (internal SAN or external domain), download + auto-install. */
export function TlsPanel() {
  const { data: s } = useTlsStatus();
  const regen = useRegenerateTls();
  const dlCert = useDownloadCert();
  const dlInstaller = useDownloadCertInstaller();

  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [cn, setCn] = useState('');
  const [sans, setSans] = useState<string[]>([]);
  const [sanInput, setSanInput] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const primary = cn.trim() || s?.cn || host;
  const trusted = s?.hasSan && !s?.error; // self-signed-with-SAN can be trusted once imported
  const expiryColor = s?.daysLeft == null ? 'text-muted' : s.daysLeft < 30 ? 'text-danger' : s.daysLeft < 90 ? 'text-warning' : 'text-emerald-300';

  const sansForCurrentHost = useMemo(() => (s?.sans ?? []).some((x) => x === host), [s?.sans, host]);

  // Seed the editable SAN list from the CURRENT certificate so existing domains can be removed (✕) before regenerating.
  useEffect(() => {
    if (seeded || s == null) return;
    const init = (s.sans ?? []).filter((x) => x.toLowerCase() !== 'localhost');
    setSans(init.length ? init : [host].filter(Boolean));
    setSeeded(true);
  }, [s, seeded, host]);

  const addSans = (raw: string) => {
    const add = raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    if (add.length) setSans((prev) => Array.from(new Set([...prev, ...add])));
    setSanInput('');
  };
  const removeSan = (x: string) => setSans((prev) => prev.filter((v) => v !== x));

  const doRegen = async () => {
    setMsg(null);
    const cnVal = (mode === 'external' ? cn.trim() : (cn.trim() || host));
    if (!cnVal) { setMsg({ ok: false, text: 'Enter a host / domain.' }); return; }
    // Use exactly the chip list (+ any half-typed value), minus the CN and localhost which the backend always adds.
    const sanList = Array.from(new Set([...sans, sanInput].flatMap((x) => x.split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean).filter((x) => x.toLowerCase() !== 'localhost' && x !== cnVal)));
    try {
      const r = await regen.mutateAsync({ cn: cnVal, sans: sanList });
      setMsg({ ok: true, text: `Certificate regenerated (SAN: ${(r.sans ?? []).join(', ')})${r.reloaded ? ' — nginx reloaded' : ' — reload nginx to apply'}. Download + install it below, then restart your browser.` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };

  return (
    <Card title="① Server certificate — IP / internal access (self-signed)" className="col-span-12" bodyClassName="p-3 space-y-3">
      {/* Current status */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg/40 p-2.5 text-2xs">
        {!s?.present ? <span className="text-muted">No certificate found.</span> : (
          <>
            <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${trusted ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{trusted ? '🔒 trust-ready' : '⚠ not trustable (no SAN)'}</span>
            <span className="text-muted">Type: <b className="text-white">{s.selfSigned ? 'self-signed' : 'CA-issued'}</b></span>
            <span className="text-muted">CN: <b className="text-white">{s.cn ?? '—'}</b></span>
            <span className="text-muted">SAN: <span className="font-mono text-white">{(s.sans ?? []).join(', ') || '—'}</span></span>
            <span className="text-muted">Expires: <b className={expiryColor}>{s.daysLeft != null ? `${s.daysLeft}d` : '—'}</b></span>
            {!sansForCurrentHost && s.hasSan && <span className="text-amber-300/90">(SAN doesn&apos;t list {host} — regenerate with this host to make it green here)</span>}
          </>
        )}
      </div>

      {/* Get the cert onto this PC */}
      <div className="rounded-lg border border-brand/20 bg-brand/[0.04] p-2.5">
        <div className="mb-1.5 text-2xs font-semibold text-brand">Install on this PC (green padlock)</div>
        <div className="mb-2 text-2xs text-muted">Download the certificate and import it into your machine&apos;s <b className="text-white">Trusted Root</b> store, then restart the browser. The one-click installer does it for you (Windows, run as Administrator).</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => dlInstaller.mutate(host)} disabled={dlInstaller.isPending || !s?.present} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50">⤓ Download auto-installer (.ps1)</button>
          <button onClick={() => dlCert.mutate()} disabled={dlCert.isPending || !s?.present} className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs text-brand hover:text-white disabled:opacity-50">⤓ Download certificate (.crt)</button>
        </div>
        <div className="mt-1.5 text-[10px] text-muted">Installer: right-click the .ps1 → Run with PowerShell (as Administrator). Or import the .crt via certlm.msc → Trusted Root Certification Authorities. Access the site by the name/IP in the SAN.</div>
      </div>

      {/* Regenerate */}
      <div className="rounded-lg border border-border bg-bg/40 p-2.5 space-y-2">
        <div className="flex items-center gap-2 text-2xs">
          <span className="font-semibold text-white">Regenerate certificate</span>
          <div className="inline-flex rounded-lg border border-border bg-bg p-0.5">
            <button onClick={() => setMode('internal')} className={`rounded px-2 py-0.5 ${mode === 'internal' ? 'bg-brand text-white' : 'text-muted'}`}>Internal (self-signed)</button>
            <button onClick={() => setMode('external')} className={`rounded px-2 py-0.5 ${mode === 'external' ? 'bg-brand text-white' : 'text-muted'}`}>External domain</button>
          </div>
        </div>
        {mode === 'internal' ? (
          <div className="text-2xs text-muted">Self-signed with a proper SAN so it&apos;s trustable on your machines. Primary defaults to this host (<span className="font-mono text-white">{host}</span>).</div>
        ) : (
          <div className="text-2xs text-muted">Enter your public domain (DNS A-record → this server). This issues a SAN cert for the domain now; for a <b className="text-white">publicly-trusted</b> green lock without importing, follow <b className="text-white">Help → §15</b> to run Let&apos;s Encrypt for that domain.</div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-2xs text-muted">{mode === 'external' ? 'Domain (CN)' : 'Primary host / IP (CN)'}</label>
            <input value={cn} onChange={(e) => setCn(e.target.value)} placeholder={mode === 'external' ? 'mcmf.yourco.com' : host} className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
          </div>
          <div className="min-w-[240px] flex-[2]">
            <label className="mb-1 block text-2xs text-muted">Domains / IPs in the certificate (SAN) — ✕ to remove</label>
            <div className="flex min-h-[34px] flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1.5">
              {sans.length === 0 && <span className="text-2xs text-muted">none yet — add a host / IP →</span>}
              {sans.map((x) => (
                <span key={x} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs ${x === host ? 'bg-emerald-500/15 text-emerald-300' : 'bg-border/50 text-white'}`}>
                  <span className="font-mono">{x}</span>
                  <button onClick={() => removeSan(x)} title={`Remove ${x}`} className="leading-none text-muted hover:text-danger">✕</button>
                </span>
              ))}
              <input value={sanInput} onChange={(e) => setSanInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSans(sanInput); } }} onBlur={() => { if (sanInput.trim()) addSans(sanInput); }} placeholder="add host / IP + Enter" className="min-w-[120px] flex-1 bg-transparent text-xs text-white placeholder:text-muted focus:outline-none" />
            </div>
          </div>
          <button onClick={doRegen} disabled={regen.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50">{regen.isPending ? 'Regenerating…' : 'Regenerate + reload'}</button>
        </div>
        {host && !sans.includes(host) && <div className="text-[10px] text-amber-300">⚠ {host} (this page&apos;s address) isn&apos;t in the list — the new cert won&apos;t be trusted here. <button onClick={() => addSans(host)} className="underline hover:text-white">Add it</button></div>}
        <div className="text-[10px] text-muted">Will issue: CN=<span className="font-mono text-white">{primary || '—'}</span> · SAN = <span className="font-mono text-white">{Array.from(new Set([primary, ...sans, 'localhost'].filter(Boolean))).join(', ')}</span>. The current cert is backed up automatically.</div>
      </div>

      {msg && <div className={`rounded-lg border px-3 py-2 text-2xs ${msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-danger/40 bg-danger/10 text-danger'}`}>{msg.text}</div>}

      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] p-2.5 text-2xs text-emerald-300/90">🌐 <b>Public domain (HTTPS + email)</b> — for a browser-trusted Let&apos;s Encrypt certificate and email (DKIM / SPF / DMARC) on your own domain, use the <b className="text-white">Domains</b> section below. The self-signed options above are for access by IP / internal hostname.</div>
    </Card>
  );
}

