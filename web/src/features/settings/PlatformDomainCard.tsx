'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { copyText } from '@/lib/clipboard';
import {
  usePlatformDomain, usePlatformUpstream, usePlatformUpload, usePlatformLeStart, usePlatformLeValidate, useClearPlatform,
  useDomainHttpsStatus,
} from '@/lib/hooks';

type Method = 'letsencrypt' | 'upload' | 'upstream';

/**
 * One domain per server (each customer runs their own deployment — no multitenancy). Enter the domain,
 * pick how HTTPS is provided (auto Let's Encrypt / upload your own cert / TLS terminated upstream), and the
 * platform serves on it. Remove reverts to IP / self-signed.
 */
export function PlatformDomainCard() {
  const { data: st } = usePlatformDomain();
  const clear = useClearPlatform();
  const [domain, setDomain] = useState('');
  const [method, setMethod] = useState<Method>('letsencrypt');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { if (st?.domain && !domain) setDomain(st.domain); if (st?.mode) setMethod(st.mode as Method); }, [st?.domain, st?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = st?.httpsLive;
  return (
    <Card title="Platform Domain (this server)" className="col-span-12" bodyClassName="p-3 space-y-3">
      {/* Current state */}
      <div className={`rounded-lg border p-2.5 text-2xs ${live ? 'border-emerald-500/40 bg-emerald-500/[0.06]' : 'border-amber-500/30 bg-amber-500/[0.05]'}`}>
        {live ? (
          <div className="text-emerald-300">✓ Platform is live at <a href={`https://${st!.domain}`} target="_blank" rel="noreferrer" className="font-semibold underline">https://{st!.domain}</a>
            {st!.mode === 'upstream' ? ' — TLS handled by your upstream proxy/load balancer.' : st!.trusted ? ' — browser-trusted certificate (green padlock).' : ' — certificate installed (not yet browser-trusted; import it on clients).'}
            {st!.cert.daysLeft != null && st!.mode !== 'upstream' && <span className="text-muted"> Cert expires in {st!.cert.daysLeft}d.</span>}
          </div>
        ) : (
          <div className="text-amber-300">No platform domain set — the app is reachable by IP (<span className="font-mono text-white">{st?.serverIp ?? '—'}</span>) with a self-signed certificate. Add your domain below to serve on it with HTTPS.</div>
        )}
      </div>
      <div className="text-2xs text-muted">Each customer runs their own server, so this is a single domain — no multitenancy needed. The web app works on any hostname automatically; it only needs a valid certificate for the domain. Point the domain&apos;s <b className="text-white">DNS A record</b> at <span className="font-mono text-white">{st?.serverIp ?? 'this server'}</span> first.</div>

      {/* Domain + method */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <label className="mb-1 block text-2xs text-muted">Your domain</label>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.customerco.com" className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </div>
        <div className="inline-flex rounded-lg border border-border bg-bg p-0.5 text-2xs">
          {([['letsencrypt', "Let's Encrypt"], ['upload', 'Upload cert'], ['upstream', 'Upstream TLS']] as [Method, string][]).map(([m, label]) => (
            <button key={m} onClick={() => { setMethod(m); setMsg(null); }} className={`rounded px-2 py-1 ${method === m ? 'bg-brand text-white' : 'text-muted hover:text-white'}`}>{label}</button>
          ))}
        </div>
      </div>

      {method === 'letsencrypt' && <LetsEncrypt domain={domain} onMsg={setMsg} />}
      {method === 'upload' && <UploadCert domain={domain} onMsg={setMsg} />}
      {method === 'upstream' && <Upstream domain={domain} onMsg={setMsg} />}

      {msg && <Msg msg={msg} />}

      {st?.domain && (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="text-2xs text-muted">Current: <span className="font-mono text-white">{st.domain}</span> · <span className="uppercase">{st.mode || 'none'}</span></span>
          <button onClick={() => confirm(`Remove ${st.domain}? The server reverts to its IP with a self-signed certificate.`) && clear.mutate()} disabled={clear.isPending} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-danger hover:bg-danger/10 disabled:opacity-50">{clear.isPending ? 'Removing…' : 'Remove domain'}</button>
        </div>
      )}
    </Card>
  );
}

function LetsEncrypt({ domain, onMsg }: { domain: string; onMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const { data: order } = useDomainHttpsStatus();
  const start = usePlatformLeStart();
  const validate = usePlatformLeValidate();
  const mine = order?.pending && order.domain === domain.trim().toLowerCase();
  const doStart = async () => { onMsg(null); try { await start.mutateAsync(domain); onMsg({ ok: true, text: 'Order started — add the TXT record below, then Validate & go live.' }); } catch (e) { onMsg({ ok: false, text: (e as Error).message }); } };
  const doValidate = async () => { onMsg({ ok: true, text: "Validating with Let's Encrypt — can take a minute…" }); try { await validate.mutateAsync(domain); onMsg({ ok: true, text: `🔒 Live — https://${domain} now serves a browser-trusted certificate.` }); } catch (e) { onMsg({ ok: false, text: (e as Error).message }); } };
  return (
    <div className="space-y-2 rounded-md border border-border-soft bg-bg/40 p-2.5">
      <div className="text-2xs text-muted">Free, browser-trusted certificate via DNS validation (works behind NAT). Add one TXT record, then validate — installs and reloads automatically; on failure the current cert stays.</div>
      {!mine ? (
        <button onClick={doStart} disabled={start.isPending || !domain.trim() || (order?.pending && !mine)} className="rounded-md bg-emerald-600 px-3 py-1.5 text-2xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{start.isPending ? 'Starting…' : '① Get DNS TXT record'}</button>
      ) : (
        <>
          <RecordBox rec={{ name: order!.recordName ?? '', value: order!.recordValue ?? '' }} />
          <button onClick={doValidate} disabled={validate.isPending} className="rounded-md bg-emerald-600 px-3 py-1.5 text-2xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{validate.isPending ? '② Validating…' : "② I've added it — Validate & go live"}</button>
        </>
      )}
      {order?.pending && !mine && <div className="text-[10px] text-amber-300">Another order is in progress for {order.domain} — finish or cancel it first.</div>}
    </div>
  );
}

function UploadCert({ domain, onMsg }: { domain: string; onMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const upload = usePlatformUpload();
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const doUpload = async () => { onMsg(null); try { await upload.mutateAsync({ domain, certPem, keyPem }); onMsg({ ok: true, text: `Certificate installed — https://${domain} is serving it.` }); setCertPem(''); setKeyPem(''); } catch (e) { onMsg({ ok: false, text: (e as Error).message }); } };
  return (
    <div className="space-y-2 rounded-md border border-border-soft bg-bg/40 p-2.5">
      <div className="text-2xs text-muted">Paste your own certificate (e.g. a wildcard or corporate-CA cert) and its private key. MCMF checks the key matches the cert before installing — a bad pair is rejected and nothing changes.</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-2xs text-muted">Certificate (PEM — full chain)</label>
          <textarea value={certPem} onChange={(e) => setCertPem(e.target.value)} rows={5} placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----" className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[10px] text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </div>
        <div>
          <label className="mb-1 block text-2xs text-muted">Private key (PEM — unencrypted)</label>
          <textarea value={keyPem} onChange={(e) => setKeyPem(e.target.value)} rows={5} placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----" className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[10px] text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </div>
      </div>
      <button onClick={doUpload} disabled={upload.isPending || !domain.trim() || !certPem.trim() || !keyPem.trim()} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{upload.isPending ? 'Installing…' : 'Install certificate'}</button>
    </div>
  );
}

function Upstream({ domain, onMsg }: { domain: string; onMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const save = usePlatformUpstream();
  const doSave = async () => { onMsg(null); try { await save.mutateAsync(domain); onMsg({ ok: true, text: `Saved — MCMF will use ${domain} as its public address. Make sure your load balancer / proxy terminates TLS for it and forwards to this server.` }); } catch (e) { onMsg({ ok: false, text: (e as Error).message }); } };
  return (
    <div className="space-y-2 rounded-md border border-border-soft bg-bg/40 p-2.5">
      <div className="text-2xs text-muted">TLS is terminated by your own gateway (Azure App Gateway, Cloudflare, F5, nginx, an ELB…). MCMF just records the domain as its public address; your gateway presents the trusted cert and forwards to this server.</div>
      <button onClick={doSave} disabled={save.isPending || !domain.trim()} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{save.isPending ? 'Saving…' : 'Use this domain'}</button>
    </div>
  );
}

function RecordBox({ rec }: { rec: { name: string; value: string } }) {
  return (
    <div className="rounded-md border border-border bg-bg p-2 font-mono text-[11px]">
      <Field label="Type" value="TXT" />
      <Field label="Name" value={rec.name} />
      <Field label="Value" value={rec.value} />
    </div>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="w-12 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-all text-white">{value}</span>
      <button onClick={() => copyText(value)} className="shrink-0 text-brand hover:text-white" title="Copy">⧉</button>
    </div>
  );
}
function Msg({ msg }: { msg: { ok: boolean; text: string } }) {
  return <div className={`rounded-md border px-3 py-2 text-2xs ${msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-danger/40 bg-danger/10 text-danger'}`}>{msg.text}</div>;
}
