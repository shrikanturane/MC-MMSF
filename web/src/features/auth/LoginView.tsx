'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setToken, useForgotPassword, useForgot2fa, useLogin, useVerify2fa, useEmailOtp, useSsoProviders } from '@/lib/auth';
import { stashMfa, readMfa, clearMfa, MFA_LOGIN_KEY } from '@/lib/mfa-persist';
import { PasswordInput } from '@/components/PasswordInput';

type Challenge = { token: string; remember: boolean; email: string };

function ssoError(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('sso_error');
}

export function LoginView() {
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [challenge, setChallengeState] = useState<Challenge | null>(null);
  // Restore a pending 2FA challenge after a mobile app-switch / PWA reload so the user lands back
  // on the verification screen instead of the username/password form.
  useEffect(() => {
    const saved = readMfa<Challenge>(MFA_LOGIN_KEY);
    if (saved) setChallengeState(saved);
  }, []);
  const setChallenge = (c: Challenge | null) => {
    if (c) stashMfa(MFA_LOGIN_KEY, c);
    else clearMfa(MFA_LOGIN_KEY);
    setChallengeState(c);
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white">M</div>
          <h1 className="text-lg font-semibold text-white">MCMF</h1>
          <p className="text-2xs text-muted">Multi-Cloud Management Framework</p>
        </div>
        {challenge ? (
          <TwoFactorForm challenge={challenge.token} remember={challenge.remember} email={challenge.email} onBack={() => setChallenge(null)} />
        ) : mode === 'login' ? (
          <LoginForm onForgot={() => setMode('forgot')} onChallenge={(token, remember, email) => setChallenge({ token, remember, email })} />
        ) : (
          <ForgotForm onBack={() => setMode('login')} />
        )}
      </div>
    </div>
  );
}

function LoginForm({ onForgot, onChallenge }: { onForgot: () => void; onChallenge: (token: string, remember: boolean, email: string) => void }) {
  const login = useLogin();
  const qc = useQueryClient();
  const sso = useSsoProviders();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState<string | null>(ssoError());
  const ssoOn = sso.data?.google || sso.data?.microsoft;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const res = await login.mutateAsync({ email, password, remember });
      if ('twoFactorRequired' in res) {
        onChallenge(res.challenge, remember, email);
        return;
      }
      setToken(res.token);
      window.location.href = '/topology'; // land on the network topology first
      return;
    } catch (ex) {
      setErr((ex as Error).message || 'Login failed');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border bg-panel p-6">
      <div className="text-sm font-semibold text-white">Sign in</div>
      {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}

      <label className="block">
        <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Email</span>
        <input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
      </label>

      <label className="block">
        <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Password</span>
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password"
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
      </label>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-2xs text-muted-light">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-brand" />
          Remember me (30 days)
        </label>
        <button type="button" onClick={onForgot} className="text-2xs text-brand hover:underline">Forgot password?</button>
      </div>

      <button type="submit" disabled={login.isPending || !email || !password}
        className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-50">
        {login.isPending ? 'Signing in…' : 'Sign in'}
      </button>

      {ssoOn && (
        <>
          <div className="flex items-center gap-2 py-1 text-2xs text-muted"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
          <div className="space-y-2">
            {sso.data?.google && (
              <a href="/api/auth/sso/google/start" className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm text-white hover:bg-card-hover">
                <span className="text-base">G</span> Continue with Google
              </a>
            )}
            {sso.data?.microsoft && (
              <a href="/api/auth/sso/microsoft/start" className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm text-white hover:bg-card-hover">
                <span className="text-base">⊞</span> Continue with Microsoft
              </a>
            )}
          </div>
        </>
      )}
      <p className="text-center text-2xs text-muted">Role-based access · admin · operator · viewer</p>
    </form>
  );
}

function TwoFactorForm({ challenge, remember, email, onBack }: { challenge: string; remember: boolean; email: string; onBack: () => void }) {
  const verify = useVerify2fa();
  const forgot = useForgot2fa();
  const emailOtp = useEmailOtp();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<{ emailConfigured: boolean } | null>(null);
  const [otpMsg, setOtpMsg] = useState<string | null>(null);

  const sendEmailCode = async () => {
    setErr(null); setOtpMsg(null);
    try { const r = await emailOtp.mutateAsync({ challenge }); setOtpMsg(`Code sent to ${r.to} — it expires in 10 minutes.`); }
    catch (ex) { setErr((ex as Error).message || 'Could not send the email code'); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const res = await verify.mutateAsync({ challenge, code: code.trim(), remember });
      clearMfa(MFA_LOGIN_KEY); // 2FA complete — drop the persisted challenge
      setToken(res.token);
      window.location.href = '/topology';
      return;
    } catch (ex) {
      setErr((ex as Error).message || 'Verification failed');
    }
  };

  const sendRecovery = async () => {
    try {
      const r = await forgot.mutateAsync({ email });
      setSent({ emailConfigured: r.emailConfigured });
    } catch {
      setSent({ emailConfigured: false });
    }
  };

  if (sent) {
    return (
      <div className="space-y-3 rounded-2xl border border-border bg-panel p-6">
        <div className="text-sm font-semibold text-white">Check your email</div>
        <p className="text-2xs text-muted-light">If 2FA is enabled for <span className="text-white">{email}</span>, a link to disable it was sent (valid 30 min). Disable it, then sign in with your password and re-enrol.</p>
        {!sent.emailConfigured && <p className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-2xs text-muted-light">⚠ Email isn’t configured (SMTP). Ask your admin to retrieve the link from the API server logs, or use a recovery code above.</p>}
        <button onClick={onBack} className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm text-muted-light hover:text-white">Back to sign in</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border bg-panel p-6">
      <div className="text-sm font-semibold text-white">Two-factor verification</div>
      <p className="text-2xs text-muted">Enter the 6-digit code from your authenticator app, a code emailed to you, or a recovery code.</p>
      {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}
      {otpMsg && <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-2xs text-success">{otpMsg}</div>}
      <input
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="123456"
        inputMode="numeric"
        autoComplete="one-time-code"
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-center font-mono text-lg tracking-widest text-white placeholder:text-muted focus:border-brand focus:outline-none"
      />
      <button type="submit" disabled={verify.isPending || !code} className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-50">
        {verify.isPending ? 'Verifying…' : 'Verify'}
      </button>
      <button type="button" onClick={sendEmailCode} disabled={emailOtp.isPending} className="w-full rounded-lg border border-border bg-card px-4 py-2 text-2xs font-medium text-brand hover:text-white disabled:opacity-50">
        {emailOtp.isPending ? 'Sending…' : '✉ Email me a code instead'}
      </button>
      <div className="flex items-center justify-between text-2xs">
        <button type="button" onClick={onBack} className="text-brand hover:underline">Back to sign in</button>
        <button type="button" onClick={sendRecovery} disabled={forgot.isPending} className="text-brand hover:underline disabled:opacity-50">Lost your device?</button>
      </div>
    </form>
  );
}

function ForgotForm({ onBack }: { onBack: () => void }) {
  const forgot = useForgotPassword();
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<{ emailConfigured: boolean } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await forgot.mutateAsync({ email });
      setDone({ emailConfigured: res.emailConfigured });
    } catch {
      setDone({ emailConfigured: false });
    }
  };

  if (done) {
    return (
      <div className="space-y-3 rounded-2xl border border-border bg-panel p-6">
        <div className="text-sm font-semibold text-white">Check your email</div>
        <p className="text-2xs text-muted-light">
          If an account exists for <span className="text-white">{email}</span>, a password-reset link (valid 30 minutes) has been sent.
        </p>
        {!done.emailConfigured && (
          <p className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-2xs text-muted-light">
            ⚠ Email delivery isn’t configured (SMTP). Ask your administrator to retrieve the reset link from the API server logs.
          </p>
        )}
        <button onClick={onBack} className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm text-muted-light hover:text-white">Back to sign in</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border bg-panel p-6">
      <div className="text-sm font-semibold text-white">Reset your password</div>
      <p className="text-2xs text-muted">Enter your email and we’ll send a reset link.</p>
      <label className="block">
        <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Email</span>
        <input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
      </label>
      <button type="submit" disabled={forgot.isPending || !email}
        className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-50">
        {forgot.isPending ? 'Sending…' : 'Send reset link'}
      </button>
      <button type="button" onClick={onBack} className="w-full text-center text-2xs text-brand hover:underline">Back to sign in</button>
    </form>
  );
}
