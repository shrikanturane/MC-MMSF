'use client';

import { useState } from 'react';
import QRCode from 'qrcode';
import { Card } from '@/components/ui';
import { PasswordInput } from '@/components/PasswordInput';
import { timeAgo } from '@/lib/format';
import { useAuthUser, useChangeMyPassword, useAudit, useSessions, useRevokeSession, useSetup2fa, useEnable2fa, useDisable2fa } from '@/lib/auth';

function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

const ACTION_META: Record<string, { label: string; color: string }> = {
  login: { label: 'Login', color: '#22c55e' },
  login_failed: { label: 'Login failed', color: '#ef4444' },
  logout: { label: 'Logout', color: '#64748b' },
  password_changed: { label: 'Password changed', color: '#f59e0b' },
  user_created: { label: 'User created', color: '#3b82f6' },
  user_updated: { label: 'User updated', color: '#3b82f6' },
  user_deleted: { label: 'User deleted', color: '#ef4444' },
};

export function AccountSecurity() {
  const { data: me } = useAuthUser();
  return (
    <>
      <ChangePasswordCard />
      <TwoFactorCard />
      <SessionsPanel />
      {me?.role === 'admin' && <AuditLogPanel />}
    </>
  );
}

export function TwoFactorCard() {
  const { data: me } = useAuthUser();
  const setup = useSetup2fa();
  const enable = useEnable2fa();
  const disable = useDisable2fa();
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const enabled = me?.twoFactorEnabled;

  const startSetup = async () => {
    setErr(null); setCode('');
    const d = await setup.mutateAsync();
    setSetupData(d);
    QRCode.toDataURL(d.otpauthUrl, { margin: 1, width: 180 }).then(setQr).catch(() => setQr(null));
  };
  const confirmEnable = async () => {
    setErr(null);
    try {
      const r = await enable.mutateAsync(code.trim());
      setSetupData(null); setQr(null); setCode('');
      setRecovery(r.recoveryCodes);
    } catch (e) { setErr((e as Error).message); }
  };
  const confirmDisable = async () => {
    setErr(null);
    try { await disable.mutateAsync(code.trim()); setDisabling(false); setCode(''); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <Card title="Two-Factor Authentication" className="col-span-12 lg:col-span-6">
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}

        {recovery ? (
          <div className="space-y-2">
            <div className="text-2xs text-success">✓ 2FA enabled. Save these recovery codes — each works once if you lose your device.</div>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border bg-bg p-3 font-mono text-2xs text-white">
              {recovery.map((c) => <span key={c}>{c}</span>)}
            </div>
            <button onClick={() => setRecovery(null)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">I’ve saved them</button>
          </div>
        ) : setupData ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            {qr && <img src={qr} alt="2FA QR" className="h-44 w-44 shrink-0 rounded-lg bg-[#ffffff] p-1" />}
            <div className="min-w-0 flex-1 space-y-2">
              <div className="text-2xs text-muted">Scan with Google Authenticator / Authy, or enter the key manually:</div>
              <div className="break-all rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-2xs text-muted-light">{setupData.secret}</div>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" inputMode="numeric" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-center font-mono tracking-widest text-white focus:border-brand focus:outline-none" />
              <div className="flex gap-2">
                <button onClick={confirmEnable} disabled={enable.isPending || code.length < 6} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{enable.isPending ? 'Verifying…' : 'Verify & enable'}</button>
                <button onClick={() => { setSetupData(null); setQr(null); }} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
              </div>
            </div>
          </div>
        ) : enabled ? (
          disabling ? (
            <div className="space-y-2">
              <div className="text-2xs text-muted">Enter a current code (or recovery code) to turn off 2FA.</div>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-center font-mono text-white focus:border-brand focus:outline-none" />
              <div className="flex gap-2">
                <button onClick={confirmDisable} disabled={disable.isPending || !code} className="rounded-lg bg-danger/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-danger disabled:opacity-50">Disable 2FA</button>
                <button onClick={() => { setDisabling(false); setCode(''); }} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-2xs"><span className="rounded bg-success/15 px-2 py-0.5 text-success">✓ Enabled</span><span className="text-muted">Your account is protected with an authenticator app.</span></div>
              <button onClick={() => { setErr(null); setDisabling(true); }} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-danger hover:text-white">Disable</button>
            </div>
          )
        ) : (
          <div className="flex items-center justify-between">
            <div className="text-2xs text-muted">Add a second factor (TOTP) so a stolen password isn’t enough to sign in.</div>
            <button onClick={startSetup} disabled={setup.isPending} className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{setup.isPending ? '…' : 'Enable 2FA'}</button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function SessionsPanel() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  return (
    <Card title="Active Sessions" className="col-span-12" bodyClassName="p-0">
      <div className="max-h-72 overflow-auto divide-y divide-border-soft">
        {sessions.data?.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-2xs font-medium text-white">{deviceLabel(s.userAgent)}</span>
                {s.current && <span className="rounded bg-success/15 px-1.5 py-0.5 text-2xs text-success">this device</span>}
              </div>
              <div className="text-2xs text-muted">
                {s.ip || 'unknown IP'} · active {timeAgo(s.lastSeenAt)} · expires {timeAgo(s.expiresAt).replace(' ago', '')}
              </div>
            </div>
            <button
              onClick={() => revoke.mutate(s.id)}
              disabled={s.current || revoke.isPending}
              className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-2xs text-danger hover:text-white disabled:opacity-40"
              title={s.current ? 'Use Sign out for this device' : 'Revoke this session'}
            >
              {s.current ? 'current' : 'Revoke'}
            </button>
          </div>
        ))}
        {sessions.data?.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">No active sessions.</div>}
      </div>
    </Card>
  );
}

export function ChangePasswordCard() {
  const change = useChangeMyPassword();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    setMsg(null);
    if (next !== confirm) return setMsg({ ok: false, text: 'New passwords do not match' });
    if (next.length < 6) return setMsg({ ok: false, text: 'New password must be at least 6 characters' });
    try {
      await change.mutateAsync({ currentPassword: cur, newPassword: next });
      setMsg({ ok: true, text: 'Password updated' });
      setCur(''); setNext(''); setConfirm('');
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <Card title="Change My Password" className="col-span-12 lg:col-span-6">
      <div className="space-y-3">
        {msg && (
          <div className={`rounded-lg border px-3 py-2 text-2xs ${msg.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>{msg.text}</div>
        )}
        <PwField label="Current Password" value={cur} onChange={setCur} />
        <PwField label="New Password" value={next} onChange={setNext} />
        <PwField label="Confirm New Password" value={confirm} onChange={setConfirm} />
        <div className="flex justify-end">
          <button
            onClick={submit}
            disabled={change.isPending || !cur || !next}
            className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50"
          >
            {change.isPending ? 'Updating…' : 'Update password'}
          </button>
        </div>
      </div>
    </Card>
  );
}

/** The security audit trail now lives in a single source — Activity & Event Tracking → Audit Trail. */
export function AuditLogPanel() {
  return (
    <Card title="Security Audit Log" className="col-span-12 lg:col-span-6">
      <div className="flex flex-col items-start gap-2 text-2xs text-muted-light">
        <p>The security audit trail (logins, user &amp; password changes, access events) is now kept in one place along with alerts, the SIEM stream and the event timeline.</p>
        <a href="/activity" className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">Open Activity &amp; Event Tracking → Audit Trail</a>
      </div>
    </Card>
  );
}

function PwField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <PasswordInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
      />
    </label>
  );
}
