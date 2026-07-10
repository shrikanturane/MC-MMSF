'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui';
import { useBlocklist, useUpdateBlocklist, type BlocklistEntry, type CountryMode } from '@/lib/hooks';
import { COUNTRIES, ZONES, COUNTRY_NAME } from '@/lib/countries';

const TYPE_LABEL: Record<BlocklistEntry['type'], string> = { ip: 'IP address', cidr: 'Subnet (CIDR)', range: 'IP range' };
const PLACEHOLDER: Record<BlocklistEntry['type'], string> = { ip: '203.0.113.10', cidr: '203.0.113.0/24', range: '203.0.113.10-203.0.113.50' };

/** Admin: block access to MCMF by IP / subnet / range, and allow/block whole countries (GeoIP). */
export function NetworkAccessPanel() {
  const { data } = useBlocklist();
  const save = useUpdateBlocklist();
  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<BlocklistEntry[]>([]);
  const [countryMode, setCountryMode] = useState<CountryMode>('off');
  const [countryList, setCountryList] = useState<string[]>([]);
  const [f, setF] = useState<BlocklistEntry>({ type: 'ip', value: '', note: '', enabled: true });
  const [cq, setCq] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data) { setEnabled(data.enabled); setEntries(data.entries ?? []); setCountryMode(data.countryMode ?? 'off'); setCountryList((data.countryList ?? []).map((c) => c.toUpperCase())); }
  }, [data]);

  const add = () => {
    const value = f.value.trim();
    if (!value) return;
    setEntries([...entries, { ...f, value, enabled: true }]);
    setF({ type: f.type, value: '', note: '', enabled: true });
  };
  const removeEntry = (i: number) => setEntries(entries.filter((_, idx) => idx !== i));
  const toggleEntry = (i: number) => setEntries(entries.map((e, idx) => (idx === i ? { ...e, enabled: e.enabled === false } : e)));

  const toggleCountry = (code: string) => setCountryList((l) => (l.includes(code) ? l.filter((c) => c !== code) : [...l, code]));
  const sel = useMemo(() => new Set(countryList), [countryList]);
  const onSave = async () => {
    setMsg(null);
    try { await save.mutateAsync({ enabled, entries, countryMode, countryList }); setMsg('Saved. Applies within ~15 seconds.'); }
    catch (e) { setMsg((e as Error).message); }
  };

  // Self-lockout guard: would the chosen country policy block the admin's own (public) country?
  const myCC = data?.yourCountry ?? null;
  const countryBlocksMe = countryMode !== 'off' && myCC && (countryMode === 'allow' ? !sel.has(myCC) : sel.has(myCC));

  const inp = 'rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none';
  const q = cq.trim().toLowerCase();

  return (
    <Card title="Network access control" className="col-span-12">
      <div className="space-y-5 text-xs">
        {/* ── IP / subnet / range blocklist ───────────────────────────── */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-white">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-brand" />
              Enforce IP blocklist — deny access from matching IP / subnet / range
            </label>
            {data?.yourIp && <span className="text-2xs text-muted">Your IP: <span className="font-mono text-muted-light">{data.yourIp}</span>{myCC && <> · country <span className="font-mono text-muted-light">{myCC}</span></>}</span>}
          </div>
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-bg/40 p-2.5">
            <div>
              <label className="mb-1 block text-2xs text-muted">Type</label>
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as BlocklistEntry['type'] })} className={inp}>
                {(['ip', 'cidr', 'range'] as const).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </div>
            <div className="min-w-[180px] flex-1">
              <label className="mb-1 block text-2xs text-muted">Value</label>
              <input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={PLACEHOLDER[f.type]} className={`w-full ${inp}`} />
            </div>
            <div className="min-w-[140px] flex-1">
              <label className="mb-1 block text-2xs text-muted">Note</label>
              <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="why" className={`w-full ${inp}`} />
            </div>
            <button onClick={add} disabled={!f.value.trim()} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">+ Add</button>
          </div>
          {entries.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-2xs">
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={i} className="border-t border-border-soft first:border-0">
                      <td className="px-3 py-1.5 w-8"><input type="checkbox" checked={e.enabled !== false} onChange={() => toggleEntry(i)} className="accent-brand" /></td>
                      <td className="px-3 py-1.5 text-muted-light">{TYPE_LABEL[e.type]}</td>
                      <td className="px-3 py-1.5 font-mono text-white">{e.value}</td>
                      <td className="px-3 py-1.5 text-muted">{e.note}</td>
                      <td className="px-3 py-1.5 text-right"><button onClick={() => removeEntry(i)} className="text-danger hover:underline">Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Country access (GeoIP) ──────────────────────────────────── */}
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium text-white">Country access</span>
            <select value={countryMode} onChange={(e) => setCountryMode(e.target.value as CountryMode)} className={inp}>
              <option value="off">Off — all countries allowed</option>
              <option value="allow">Allow ONLY selected countries (block the rest)</option>
              <option value="block">Block selected countries</option>
            </select>
            <button onClick={() => { setCountryMode('allow'); setCountryList(['US', 'IN']); }} className="rounded-md border border-brand/50 bg-brand/10 px-2.5 py-1 text-2xs text-brand hover:bg-brand/20">Allow only US + India</button>
            {countryList.length > 0 && <span className="text-2xs text-muted">{countryList.length} selected</span>}
          </div>

          {countryBlocksMe && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-2xs text-danger">⚠ This policy would block your own country ({myCC}). You're on a private/LAN IP now so you're safe, but public access from {myCC} would be denied.</div>}

          {countryMode !== 'off' && (
            <>
              <input value={cq} onChange={(e) => setCq(e.target.value)} placeholder="Search countries…" className={`w-full max-w-xs ${inp}`} />
              {countryList.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {countryList.map((c) => (
                    <span key={c} className="flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-2xs text-brand">{c} · {COUNTRY_NAME[c] ?? c}<button onClick={() => toggleCountry(c)} className="text-brand/70 hover:text-white">✕</button></span>
                  ))}
                </div>
              )}
              <div className="max-h-72 space-y-2 overflow-auto rounded-lg border border-border bg-bg/30 p-2">
                {ZONES.map((zone) => {
                  const inZone = COUNTRIES.filter((c) => c.zone === zone && (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)));
                  if (inZone.length === 0) return null;
                  const allSel = inZone.every((c) => sel.has(c.code));
                  return (
                    <div key={zone}>
                      <div className="mb-1 flex items-center gap-2">
                        <span className="text-2xs font-semibold uppercase tracking-wide text-muted">{zone}</span>
                        <button onClick={() => setCountryList((l) => allSel ? l.filter((x) => !inZone.some((c) => c.code === x)) : [...new Set([...l, ...inZone.map((c) => c.code)])])} className="text-2xs text-brand hover:underline">{allSel ? 'clear' : 'all'}</button>
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-3">
                        {inZone.map((c) => (
                          <label key={c.code} className="flex items-center gap-1.5 text-2xs text-muted-light">
                            <input type="checkbox" checked={sel.has(c.code)} onChange={() => toggleCountry(c.code)} className="accent-brand" />
                            <span className="font-mono text-muted">{c.code}</span> {c.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-2xs text-muted">Country = GeoIP lookup of the client's public IP. Private/LAN IPs (e.g. your {data?.yourIp}) are never country-blocked, so you won't lock yourself out from the office network.</div>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border pt-3">
          <button onClick={onSave} disabled={save.isPending} className="rounded-md bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{save.isPending ? 'Saving…' : 'Save access control'}</button>
          {msg && <span className="text-2xs text-muted">{msg}</span>}
        </div>
      </div>
    </Card>
  );
}
