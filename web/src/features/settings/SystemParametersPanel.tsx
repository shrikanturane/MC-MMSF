'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { useSettings, useUpdateSettings } from '@/lib/hooks';

type SP = NonNullable<ReturnType<typeof useSettings>['data']>['systemParams'];

const FIELDS: { key: keyof NonNullable<SP>; label: string; unit: string; help: string; min: number; max: number }[] = [
  { key: 'monitorIntervalSec', label: 'Monitoring check interval', unit: 'sec', help: 'How often host & service monitors are probed. Applies live.', min: 5, max: 3600 },
  { key: 'alertEvalSec', label: 'Alert evaluation interval', unit: 'sec', help: 'How often the alert engine evaluates rules. Applies live.', min: 10, max: 3600 },
  { key: 'agentOfflineSec', label: 'Agent “offline after”', unit: 'sec', help: 'A guest agent shows offline after no check-in for this long.', min: 30, max: 86400 },
  { key: 'agentRetentionDays', label: 'Stale-agent retention', unit: 'days', help: 'Agents with no data for this long are pruned (with their auto-created resources).', min: 1, max: 3650 },
  { key: 'approvalExpiryDays', label: 'Approval request expiry', unit: 'days', help: 'A pending approval request auto-expires after this many days.', min: 1, max: 365 },
  { key: 'logTtlSettingDays', label: 'Log retention (ClickHouse TTL)', unit: 'days', help: 'Log store retention. Applied when the log store (re)initialises.', min: 1, max: 3650 },
  { key: 'sessionTimeoutHours', label: 'Session timeout', unit: 'hours', help: 'Lifetime of a normal sign-in (not “remember me”). Applies to new sign-ins.', min: 1, max: 720 },
];

export function SystemParametersPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [vals, setVals] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (settings.data?.systemParams) setVals({ ...(settings.data.systemParams as any) }); }, [settings.data?.systemParams]);
  if (settings.isError) return null; // non-admin

  const save = async () => {
    setSaved(false);
    await update.mutateAsync({ systemParams: vals }).catch(() => undefined);
    setSaved(true); setTimeout(() => setSaved(false), 2500);
  };

  return (
    <Card title="System Parameters" className="col-span-12"
      action={<button onClick={save} disabled={update.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50">{update.isPending ? 'Saving…' : saved ? '✓ Saved' : 'Save'}</button>}>
      <div className="border-b border-border px-4 py-2 text-2xs text-muted">
        Operator-tunable runtime parameters — change them here, <b className="text-white">no redeploy</b>. Interval changes apply on the next tick; others apply within ~20s. Values are clamped to safe ranges.
      </div>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.key} className="rounded-lg border border-border bg-card-hover/40 p-3">
            <label className="block text-2xs font-medium text-white">{f.label}</label>
            <div className="mt-1.5 flex items-center gap-2">
              <input type="number" min={f.min} max={f.max} value={vals[f.key] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
                className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-xs text-white tabular-nums focus:border-brand focus:outline-none" />
              <span className="text-2xs text-muted">{f.unit}</span>
            </div>
            <div className="mt-1 text-2xs text-muted">{f.help} <span className="text-muted-light">({f.min}–{f.max})</span></div>
          </div>
        ))}
      </div>
    </Card>
  );
}
