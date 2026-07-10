'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import { copyText } from '@/lib/clipboard';
import {
  useDomains, useAddDomain, useRemoveDomain,
  useDomainEmailSetup, useDomainEmailVerify, useDomainEmailActive,
  useDomainHttpsStatus, useDomainHttpsStart, useDomainHttpsValidate, useDomainHttpsCancel,
  type DomainItem, type DnsRecord,
} from '@/lib/hooks';

/** Complete domain management — add/remove domains, set up HTTPS (Let's Encrypt) and email (DKIM/SPF/DMARC). */
export function DomainsPanel() {
  const { data } = useDomains();
  const add = useAddDomain();
  const [domain, setDomain] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const doAdd = async () => {
    setErr(null);
    if (!domain.trim()) { setErr('Enter a domain.'); return; }
    try { await add.mutateAsync(domain.trim()); setDomain(''); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <Card title="② Custom domains — HTTPS &amp; Email" className="col-span-12" bodyClassName="p-3 space-y-3">
      <div className="text-2xs text-muted">Add your own domains and manage them end-to-end: a browser-trusted <b className="text-white">HTTPS</b> certificate (Let&apos;s Encrypt, DNS-validated — works behind NAT) and <b className="text-white">email sending</b> with DKIM + SPF + DMARC so mail from MCMF authenticates as your domain. Server IP for SPF: <span className="font-mono text-white">{data?.serverIp ?? '—'}</span>. <a href="/help?doc=tls-green-lock" className="text-brand hover:underline">Per-provider DNS steps (GoDaddy / Microsoft 365 / Bigrock / Cloudflare) →</a></div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-bg/40 p-2.5">
        <div className="min-w-[220px] flex-1">
          <label className="mb-1 block text-2xs text-muted">Add a domain</label>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doAdd(); }} placeholder="yourco.com" className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </div>
        <button onClick={doAdd} disabled={add.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{add.isPending ? 'Adding…' : '+ Add domain'}</button>
      </div>
      {err && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}

      {(data?.domains.length ?? 0) === 0 ? (
        <div className="rounded-lg border border-border bg-bg/40 px-3 py-6 text-center text-2xs text-muted">No domains yet. Add one above to set up HTTPS and/or email.</div>
      ) : (
        <div className="space-y-2">{data!.domains.map((d) => <DomainRow key={d.id} d={d} />)}</div>
      )}
    </Card>
  );
}

function DomainRow({ d }: { d: DomainItem }) {
  const remove = useRemoveDomain();
  const [open, setOpen] = useState<'https' | 'email' | null>(null);
  return (
    <div className="rounded-lg border border-border bg-card/60 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-white">{d.domain}</span>
          <Badge ok={d.httpsEnabled} okText="🔒 HTTPS" offText="HTTPS off" />
          <Badge ok={d.emailVerified} okText="✉ Email verified" offText={d.emailEnabled ? 'Email: verify pending' : 'Email off'} />
          {d.active && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-2xs text-emerald-300">active sender</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setOpen(open === 'https' ? null : 'https')} className={`rounded-md border px-2 py-1 text-2xs ${open === 'https' ? 'border-brand bg-brand/10 text-white' : 'border-border bg-card text-brand'}`}>🔒 HTTPS</button>
          <button onClick={() => setOpen(open === 'email' ? null : 'email')} className={`rounded-md border px-2 py-1 text-2xs ${open === 'email' ? 'border-brand bg-brand/10 text-white' : 'border-border bg-card text-brand'}`}>✉ Email</button>
          <button onClick={() => confirm(`Remove ${d.domain}? (Email config is deleted; HTTPS cert stays installed until replaced.)`) && remove.mutate(d.id)} className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-danger hover:bg-danger/10">Remove</button>
        </div>
      </div>
      {open === 'https' && <HttpsSection d={d} />}
      {open === 'email' && <EmailSection d={d} />}
    </div>
  );
}

function HttpsSection({ d }: { d: DomainItem }) {
  const { data: order } = useDomainHttpsStatus();
  const start = useDomainHttpsStart();
  const validate = useDomainHttpsValidate();
  const cancel = useDomainHttpsCancel();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const mine = order?.pending && order.domain === d.domain;

  const doStart = async () => { setMsg(null); try { await start.mutateAsync(d.id); setMsg({ ok: true, text: 'Order started — add the TXT record below, then Validate.' }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } };
  const doValidate = async () => { setMsg({ ok: true, text: "Validating with Let's Encrypt — can take a minute…" }); try { await validate.mutateAsync(d.id); setMsg({ ok: true, text: `🔒 Installed! Open https://${d.domain} — green padlock, no import.` }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } };

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border-soft bg-bg/40 p-2.5">
      <div className="text-2xs text-muted">Browser-trusted HTTPS via Let&apos;s Encrypt (DNS-01). Add the TXT, then validate — the cert installs and nginx reloads. If it fails, your current certificate stays and the site keeps working.</div>
      {!mine ? (
        <button onClick={doStart} disabled={start.isPending || (order?.pending && !mine)} className="rounded-md bg-emerald-600 px-3 py-1.5 text-2xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{start.isPending ? 'Starting…' : '① Get DNS TXT record'}</button>
      ) : (
        <>
          <RecordBox rec={{ type: order!.recordType ?? 'TXT', name: order!.recordName ?? '', value: order!.recordValue ?? '' }} />
          <div className="text-[10px] text-muted">Also point an <b className="text-white">A record</b> for {d.domain} → this server&apos;s public IP so the site opens on the domain.</div>
          <div className="flex flex-wrap gap-2">
            <button onClick={doValidate} disabled={validate.isPending} className="rounded-md bg-emerald-600 px-3 py-1.5 text-2xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{validate.isPending ? '② Validating…' : "② I've added it — Validate & install"}</button>
            <button onClick={() => cancel.mutate()} className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs text-muted hover:text-white">Cancel</button>
          </div>
        </>
      )}
      {order?.pending && !mine && <div className="text-[10px] text-amber-300">Another domain ({order.domain}) has an HTTPS order in progress — finish or cancel it first.</div>}
      {msg && <Msg msg={msg} />}
    </div>
  );
}

function EmailSection({ d }: { d: DomainItem }) {
  const setup = useDomainEmailSetup();
  const verify = useDomainEmailVerify();
  const setActive = useDomainEmailActive();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const doSetup = async () => { setMsg(null); try { await setup.mutateAsync(d.id); setMsg({ ok: true, text: 'DKIM key generated — add the 3 records below, then Verify.' }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } };
  const doVerify = async () => { setMsg({ ok: true, text: 'Checking DNS…' }); try { await verify.mutateAsync(d.id); setMsg({ ok: true, text: `✅ Verified — MCMF now sends email as ${d.emailFrom}, DKIM-signed (SPF/DKIM/DMARC pass).` }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } };

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border-soft bg-bg/40 p-2.5">
      <div className="text-2xs text-muted">Send email as <span className="font-mono text-white">{d.emailFrom || `notifications@${d.domain}`}</span>. Publish all three records so DKIM, SPF and DMARC pass (so mail isn&apos;t marked spam/spoofed).</div>
      {!d.emailEnabled ? (
        <button onClick={doSetup} disabled={setup.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{setup.isPending ? 'Generating…' : '① Generate DKIM key + records'}</button>
      ) : (
        <>
          {d.records?.dkim && <RecordBox label="DKIM" rec={d.records.dkim} />}
          {d.records?.spf && <RecordBox label="SPF" rec={d.records.spf} />}
          {d.records?.dmarc && <RecordBox label="DMARC" rec={d.records.dmarc} />}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={doVerify} disabled={verify.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{verify.isPending ? '② Verifying…' : d.emailVerified ? 'Re-verify' : "② I've added them — Verify"}</button>
            {d.emailVerified && (
              <label className="flex items-center gap-1.5 text-2xs text-muted-light"><input type="checkbox" checked={d.active} onChange={(e) => setActive.mutate({ id: d.id, active: e.target.checked })} className="accent-emerald-500" /> Use this domain to send MCMF email (DKIM-sign)</label>
            )}
          </div>
        </>
      )}
      {msg && <Msg msg={msg} />}
    </div>
  );
}

function RecordBox({ label, rec }: { label?: string; rec: DnsRecord }) {
  return (
    <div className="rounded-md border border-border bg-bg p-2 font-mono text-[11px]">
      {label && <div className="mb-1 text-2xs font-semibold not-italic text-brand">{label}</div>}
      <Field label="Type" value={rec.type} />
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
function Badge({ ok, okText, offText }: { ok: boolean; okText: string; offText: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-2xs ${ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-border/40 text-muted'}`}>{ok ? okText : offText}</span>;
}
function Msg({ msg }: { msg: { ok: boolean; text: string } }) {
  return <div className={`rounded-md border px-3 py-2 text-2xs ${msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-danger/40 bg-danger/10 text-danger'}`}>{msg.text}</div>;
}
