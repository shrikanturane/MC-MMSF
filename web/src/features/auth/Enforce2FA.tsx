'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { apiPost } from '@/lib/api';
import { useSetup2fa, clearToken, type AuthUser } from '@/lib/auth';
import { stashMfa, readMfa, clearMfa, MFA_SETUP_KEY } from '@/lib/mfa-persist';

type SetupData = { secret: string; otpauthUrl: string };

/**
 * Mandatory-2FA enrolment screen. Shown (by AppShell) when a user whose role requires 2FA
 * (operator / viewer) has not yet enabled it — they must set it up before using the app.
 */
export function Enforce2FA({ user }: { user: AuthUser }) {
  const qc = useQueryClient();
  const setup = useSetup2fa();
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const started = useRef(false);

  // Enable WITHOUT auto-invalidating `me` — so the recovery codes stay on screen until the user proceeds.
  const enable = useMutation({ mutationFn: (c: string) => apiPost<{ ok: boolean; recoveryCodes: string[] }>('/auth/2fa/enable', { code: c }) });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const renderQr = (d: SetupData) => { setSetupData(d); QRCode.toDataURL(d.otpauthUrl, { margin: 1, width: 184 }).then(setQr).catch(() => setQr(null)); };
    // Reuse the secret from before an app-switch / reload — fetching a fresh one would no longer
    // match the code the user already added to their authenticator app.
    const cached = readMfa<SetupData>(MFA_SETUP_KEY);
    if (cached) { renderQr(cached); return; }
    setup.mutate(undefined, {
      onSuccess: (d) => { stashMfa(MFA_SETUP_KEY, d); renderQr(d); },
      onError: () => setErr('Could not start 2FA setup. Refresh and try again.'),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    setErr(null);
    const c = code.replace(/\s/g, '');
    if (c.length < 6) { setErr('Enter the 6-digit code from your authenticator.'); return; }
    enable.mutate(c, {
      onSuccess: (r) => { clearMfa(MFA_SETUP_KEY); setRecovery(r.recoveryCodes ?? []); },
      onError: (e) => setErr((e as Error).message || 'Invalid code — try again.'),
    });
  };

  const proceed = () => { qc.invalidateQueries({ queryKey: ['me'] }); };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="mb-1 text-lg font-semibold text-white">Two-factor authentication required</div>
        <div className="mb-4 text-2xs text-muted">
          Your role (<b className="text-white">{user.role}</b>) requires 2FA. Set it up now to continue — this is a one-time step.
        </div>

        {recovery ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-2xs text-success">2FA is enabled. Save these one-time recovery codes somewhere safe — they let you sign in if you lose your device.</div>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border bg-bg p-3 font-mono text-2xs text-muted-light">
              {recovery.map((rc) => <div key={rc}>{rc}</div>)}
            </div>
            <button onClick={proceed} className="w-full rounded-lg bg-brand px-4 py-2 text-xs font-medium text-white hover:bg-brand-soft">I saved my codes — continue</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              {qr ? <img src={qr} alt="2FA QR" className="h-44 w-44 shrink-0 rounded-lg bg-[#ffffff] p-1" /> : <div className="flex h-44 w-44 items-center justify-center rounded-lg border border-border text-2xs text-muted">Generating…</div>}
              <div className="min-w-0 text-2xs text-muted">
                <p className="mb-1">1. Scan the QR with Google Authenticator, Microsoft Authenticator, Authy, etc.</p>
                <p className="mb-1">2. Or enter this secret manually:</p>
                {setupData && <div className="break-all rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-2xs text-muted-light">{setupData.secret}</div>}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-2xs text-muted">3. Enter the 6-digit code</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="123456"
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-center font-mono text-lg tracking-widest text-white placeholder:text-muted focus:border-brand focus:outline-none"
              />
            </div>
            {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-2xs text-danger">{err}</div>}
            <button onClick={submit} disabled={enable.isPending || !setupData} className="w-full rounded-lg bg-brand px-4 py-2 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{enable.isPending ? 'Verifying…' : 'Enable 2FA & continue'}</button>
            <button onClick={() => { clearMfa(MFA_SETUP_KEY); clearToken(); window.location.reload(); }} className="w-full text-center text-2xs text-muted hover:text-white">Sign out</button>
          </div>
        )}
      </div>
    </div>
  );
}
