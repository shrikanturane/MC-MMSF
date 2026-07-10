'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import { useProvisionStatus, useSyncConnection, useTestProvision, useSettings, useUpdateSettings } from '@/lib/hooks';
import { PROVIDER_COLORS, PROVIDER_LABELS, timeAgo } from '@/lib/format';
import type { ProvisionStatus } from '@/lib/types';

/** Admin-only: advanced cloud-integration (provisioning) status with Sync + Test per cloud. */
export function AdvancedCloudIntegration() {
  const status = useProvisionStatus();
  const settings = useSettings();
  const update = useUpdateSettings();
  const [saving, setSaving] = useState(false);
  if (status.isError) return null; // non-admin / no connections
  const rows = status.data ?? [];
  const on = !!settings.data?.provisioningEnabled;
  const toggle = async () => {
    if (!on && !confirm('Enable Advanced Cloud Integration?\n\nThis lets MCMF CREATE real, billable VMs / networks / disks in your clouds (after approval). Turn it off to keep MCMF in governance-only mode.')) return;
    setSaving(true);
    try { await update.mutateAsync({ provisioningEnabled: !on }); } finally { setSaving(false); }
  };
  return (
    <Card
      title="Advanced Cloud Integration"
      className="col-span-12"
      bodyClassName="p-0"
      action={
        <button onClick={toggle} disabled={saving || settings.isLoading} role="switch" aria-checked={on}
          className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-2xs font-medium transition ${on ? 'border-success/40 bg-success/15 text-success' : 'border-border bg-card text-muted'} disabled:opacity-50`}>
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${on ? 'bg-success' : 'bg-muted'}`} />
          {saving ? 'Saving…' : on ? 'Enabled — live create ON' : 'Disabled — governance only'}
        </button>
      }
    >
      <div className="border-b border-border px-4 py-2 text-2xs text-muted">
        <b className={on ? 'text-success' : 'text-warning'}>{on ? 'Live create is ON' : 'Live create is OFF (governance only)'}.</b> When enabled, MCMF can <b className="text-white">create real VMs / networks / disks</b> (after approval) in connected clouds. When disabled, provisioning requests produce an authorized plan + required permissions instead of creating anything. <b className="text-white">Test</b> runs a non-destructive permission probe; <b className="text-white">Sync</b> refreshes inventory.
      </div>
      <div className="divide-y divide-border-soft">
        {rows.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">No AWS / Azure / GCP connections yet.</div>}
        {rows.map((r) => <IntegrationRow key={r.connectionId} r={r} />)}
      </div>
    </Card>
  );
}

function IntegrationRow({ r }: { r: ProvisionStatus }) {
  const sync = useSyncConnection();
  const test = useTestProvision();
  const [probe, setProbe] = useState<{ ready: boolean; detail: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const runTest = async () => {
    setMsg(null);
    try {
      setProbe(await test.mutateAsync(r.provider));
    } catch (e) {
      setProbe({ ready: false, detail: (e as Error).message });
    }
  };
  const runSync = async () => {
    setMsg(null);
    try {
      const res = await sync.mutateAsync(r.connectionId);
      setMsg(`Synced — ${res.discovered} resources from ${res.account}.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const connected = r.status === 'connected';
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg text-2xs font-bold text-white" style={{ background: PROVIDER_COLORS[r.provider as keyof typeof PROVIDER_COLORS] }}>
            {(PROVIDER_LABELS[r.provider as keyof typeof PROVIDER_LABELS] ?? r.provider).slice(0, 2).toUpperCase()}
          </span>
          <div>
            <div className="text-sm font-medium text-white">{PROVIDER_LABELS[r.provider as keyof typeof PROVIDER_LABELS] ?? r.provider} <span className="text-2xs text-muted">· {r.connectionName}</span></div>
            <div className="flex flex-wrap items-center gap-1.5 text-2xs">
              <Badge ok={connected} okText="connected" badText={r.status} />
              <span className={`rounded px-1.5 py-0.5 ${r.execEnabled ? 'bg-brand/15 text-brand' : 'bg-border/40 text-muted'}`}>{r.execEnabled ? 'live deploy on' : 'governance only'}</span>
              {probe && <Badge ok={probe.ready} okText="provisioning ready" badText="needs permission" />}
              <span className="text-muted">{r.lastSyncAt ? `synced ${timeAgo(r.lastSyncAt)} · ${r.assetsFound} assets` : 'not synced'}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={runTest} disabled={test.isPending} className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs text-brand hover:text-white disabled:opacity-50">{test.isPending ? 'Testing…' : 'Test'}</button>
          <button onClick={runSync} disabled={sync.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{sync.isPending ? 'Syncing…' : 'Sync'}</button>
        </div>
      </div>

      {(probe || msg) && (
        <div className={`mt-2 rounded-lg border px-3 py-1.5 text-2xs ${probe && !probe.ready ? 'border-danger/30 bg-danger/10 text-danger' : 'border-success/30 bg-success/10 text-success'}`}>
          {probe ? (probe.ready ? `✓ Succeeded — ${probe.detail}` : probe.detail) : msg}
        </div>
      )}
    </div>
  );
}

function Badge({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return <span className={`rounded px-1.5 py-0.5 ${ok ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>{ok ? `✓ ${okText}` : badText}</span>;
}
