'use client';

import { useEffect, useState } from 'react';
import { useResetPassword, useReset2faToken } from '@/lib/auth';
import { PasswordInput } from '@/components/PasswordInput';

export function ResetView() {
  const reset = useResetPassword();
  const reset2fa = useReset2faToken();
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<'password' | '2fa'>('password');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setToken(p.get('token') ?? '');
    if (p.get('mode') === '2fa') setMode('2fa');
  }, []);

  const disable2fa = async () => {
    setErr(null);
    try {
      await reset2fa.mutateAsync({ token });
      setDone(true);
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (pw !== confirm) return setErr('Passwords do not match');
    if (pw.length < 6) return setErr('Password must be at least 6 characters');
    try {
      await reset.mutateAsync({ token, newPassword: pw });
      setDone(true);
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white">M</div>
          <h1 className="text-lg font-semibold text-white">MCMF</h1>
          <p className="text-2xs text-muted">{mode === '2fa' ? 'Reset two-factor authentication' : 'Set a new password'}</p>
        </div>

        {done ? (
          <div className="space-y-3 rounded-2xl border border-border bg-panel p-6 text-center">
            <div className="text-sm font-semibold text-white">{mode === '2fa' ? 'Two-factor disabled ✓' : 'Password updated ✓'}</div>
            <p className="text-2xs text-muted-light">{mode === '2fa' ? 'Sign in with your password, then re-enable 2FA from Settings.' : 'You can now sign in with your new password. All previous sessions were signed out.'}</p>
            <a href="/" className="inline-block w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-soft">Go to sign in</a>
          </div>
        ) : mode === '2fa' ? (
          <div className="space-y-3 rounded-2xl border border-border bg-panel p-6">
            <div className="text-sm font-semibold text-white">Disable two-factor authentication</div>
            <p className="text-2xs text-muted-light">This turns off 2FA for your account so you can sign in with your password and set it up again.</p>
            {!token && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">Missing or invalid link.</div>}
            {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}
            <button onClick={disable2fa} disabled={reset2fa.isPending || !token} className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-50">
              {reset2fa.isPending ? 'Disabling…' : 'Disable 2FA'}
            </button>
            <a href="/" className="block text-center text-2xs text-brand hover:underline">Back to sign in</a>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border bg-panel p-6">
            <div className="text-sm font-semibold text-white">Choose a new password</div>
            {!token && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">Missing or invalid reset link.</div>}
            {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}
            <label className="block">
              <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">New Password</span>
              <PasswordInput autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Confirm Password</span>
              <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none" />
            </label>
            <button type="submit" disabled={reset.isPending || !token || !pw}
              className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-50">
              {reset.isPending ? 'Updating…' : 'Reset password'}
            </button>
            <a href="/" className="block text-center text-2xs text-brand hover:underline">Back to sign in</a>
          </form>
        )}
      </div>
    </div>
  );
}
