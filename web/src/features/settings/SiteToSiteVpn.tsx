'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import { useVpnStatus, useVpnTest } from '@/lib/hooks';
import { PROVIDER_LABELS } from '@/lib/format';
import type { VpnPair, VpnScript } from '@/lib/types';

/** Admin-only: site-to-site VPN status, required IPsec rules, reachability test, deploy scripts. */
export function SiteToSiteVpn() {
  const status = useVpnStatus();
  if (status.isError) return null;
  const pairs = status.data?.pairs ?? [];
  return (
    <Card title="Site-to-Site VPN" className="col-span-12" bodyClassName="p-0">
      <div className="border-b border-border px-4 py-2 text-2xs text-muted">
        Cross-cloud IPsec tunnels. A pair is <span className="text-success">deployed</span> only when a VPN gateway is detected on <b className="text-white">both</b> clouds. Use the pre-filled scripts (with your auto pre-shared key) to deploy each side, open the required rules, then re-check.
      </div>
      <div className="divide-y divide-border-soft">
        {pairs.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">Connect 2+ clouds (AWS / Azure / GCP) to plan a VPN.</div>}
        {pairs.map((p) => <VpnPairRow key={`${p.a}-${p.b}`} p={p} />)}
      </div>
    </Card>
  );
}

function VpnPairRow({ p }: { p: VpnPair }) {
  const test = useVpnTest();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('');
  const [probe, setProbe] = useState<{ reachable: boolean; detail: string } | null>(null);
  const label = (x: string) => PROVIDER_LABELS[x as keyof typeof PROVIDER_LABELS] ?? x;

  const runTest = async () => {
    if (!host.trim()) return;
    try { setProbe(await test.mutateAsync({ host: host.trim() })); }
    catch (e) { setProbe({ reachable: false, detail: (e as Error).message }); }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-white">{label(p.a)} ↔ {label(p.b)}</span>
          {p.deployed
            ? <span className="rounded bg-success/15 px-1.5 py-0.5 text-2xs text-success">● deployed</span>
            : <span className="rounded bg-danger/15 px-1.5 py-0.5 text-2xs text-danger">✕ not deployed</span>}
          {!p.deployed && (
            <span className="text-2xs text-muted">
              {p.aHasGateway ? '' : `${label(p.a)} gateway missing`}{!p.aHasGateway && !p.bHasGateway ? ' · ' : ''}{p.bHasGateway ? '' : `${label(p.b)} gateway missing`}
            </span>
          )}
        </div>
        <button onClick={() => setOpen(!open)} className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs text-brand hover:text-white">{open ? 'Hide' : 'Status · Test · Deploy'}</button>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          {/* Reachability / port test */}
          <div className="rounded-lg border border-border bg-bg/40 p-3">
            <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">Test reachability</div>
            <div className="flex flex-wrap items-center gap-2">
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="peer gateway public IP" className="w-52 rounded-md border border-border bg-bg px-2.5 py-1.5 text-2xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
              <button onClick={runTest} disabled={test.isPending || !host.trim()} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{test.isPending ? 'Testing…' : 'Test port'}</button>
            </div>
            {probe && <div className={`mt-2 rounded-lg border px-3 py-1.5 text-2xs ${probe.reachable ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>{probe.reachable ? '✓ ' : '✕ '}{probe.detail}</div>}
          </div>

          {/* Required inbound/outbound rules */}
          <div className="rounded-lg border border-border bg-bg/40 p-3">
            <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">Required firewall rules (both gateways)</div>
            <table className="w-full text-2xs">
              <thead><tr className="text-left text-muted"><th className="py-1 pr-3 font-medium">Direction</th><th className="py-1 pr-3 font-medium">Protocol</th><th className="py-1 pr-3 font-medium">Port</th><th className="py-1 font-medium">Purpose</th></tr></thead>
              <tbody>
                {p.rules.map((r, i) => (
                  <tr key={i} className="border-t border-border-soft">
                    <td className="py-1 pr-3 capitalize text-white">{r.direction}</td>
                    <td className="py-1 pr-3 font-mono text-muted-light">{r.protocol}</td>
                    <td className="py-1 pr-3 font-mono text-muted-light">{r.port}</td>
                    <td className="py-1 text-muted">{r.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pre-shared key + per-cloud deploy scripts */}
          <div className="rounded-lg border border-border bg-bg/40 p-3">
            <div className="mb-1.5 flex items-center gap-2 text-2xs">
              <span className="font-semibold uppercase tracking-wide text-muted">Pre-shared key</span>
              <code className="rounded bg-bg px-2 py-0.5 font-mono text-white">{p.psk}</code>
              <span className="text-muted">(same on both ends — auto-generated, stable)</span>
            </div>
            {p.scripts.map((s) => <DeployScript key={s.provider} s={s} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function DeployScript({ s }: { s: VpnScript }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(s.script); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-2xs font-medium text-white">{PROVIDER_LABELS[s.provider as keyof typeof PROVIDER_LABELS] ?? s.provider} · {s.shell}</span>
        <button onClick={copy} className="rounded-md border border-border bg-card px-2 py-0.5 text-2xs text-brand hover:text-white">{copied ? 'Copied ✓' : '⧉ Copy'}</button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-border bg-bg p-2.5 font-mono text-2xs leading-relaxed text-muted-light">{s.script}</pre>
    </div>
  );
}
