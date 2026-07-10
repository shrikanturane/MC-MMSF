'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import { useSettings, useSetMakerChecker } from '@/lib/hooks';

/**
 * Admin-only: maker-checker (segregation of duties). Enabling is open; DISABLING requires a fresh
 * 2FA code so the control can't be silently weakened. Moved here from the Approvals view.
 */
export function MakerCheckerPanel() {
  const settings = useSettings();
  const setMc = useSetMakerChecker();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const on = !!settings.data?.makerChecker;

  const toggle = async () => {
    setErr(null);
    if (on) {
      // Disabling weakens segregation of duties → require a fresh 2FA code.
      const code = window.prompt('Disabling maker-checker removes the "a different admin must approve" safeguard.\n\nEnter your current 6-digit 2FA code to confirm:');
      if (!code) return;
      setBusy(true);
      try { await setMc.mutateAsync({ enabled: false, code: code.trim() }); }
      catch (e) { setErr((e as Error).message); }
      finally { setBusy(false); }
    } else {
      if (!confirm('Enable maker-checker?\n\nA request can no longer be approved by the same admin who raised it — a different administrator must approve, and other admins are emailed.')) return;
      setBusy(true);
      try { await setMc.mutateAsync({ enabled: true }); }
      catch (e) { setErr((e as Error).message); }
      finally { setBusy(false); }
    }
  };

  return (
    <Card
      title="Approval Process — Maker-Checker"
      className="col-span-12"
      bodyClassName="p-0"
      action={
        <button onClick={toggle} disabled={busy || settings.isLoading} role="switch" aria-checked={on}
          title="Segregation of duties: a request can't be approved by the admin who raised it. Disabling requires 2FA."
          className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-2xs font-medium transition ${on ? 'border-success/40 bg-success/15 text-success' : 'border-border bg-card text-muted'} disabled:opacity-50`}>
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${on ? 'bg-success' : 'bg-muted'}`} />
          {busy ? 'Saving…' : on ? 'Maker-checker ON' : 'Maker-checker OFF'}
        </button>
      }
    >
      <div className="px-4 py-3 text-2xs text-muted">
        <b className={on ? 'text-success' : 'text-warning'}>{on ? 'Maker-checker is ON.' : 'Maker-checker is OFF.'}</b> When ON, a sensitive request <b className="text-white">cannot be approved by the same admin who raised it</b> — a different administrator must approve, and other admins are notified by email (segregation of duties).
        <div className="mt-1.5 flex items-start gap-1.5 text-muted-light"><span>🔒</span><span><b className="text-white">Turning it OFF requires a fresh 2FA code</b> — enabling is open, but the control can't be silently weakened. Every change is recorded in the audit log.</span></div>
      </div>
      {err && <div className="mx-4 mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-2xs text-danger">{err}</div>}
    </Card>
  );
}
