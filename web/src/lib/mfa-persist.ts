'use client';

// Persist short-lived MFA in-progress state across mobile app switches / PWA reloads.
// Mobile browsers — especially iOS standalone PWAs — reload the page when you return from your
// authenticator app, which wipes React state. Without this, the user is bounced back to the
// username/password screen (login) or handed a brand-new secret (enrolment). We stash the pending
// step in localStorage with a short TTL so the user resumes exactly where they were.

const TTL_MS = 10 * 60_000; // long enough to open the authenticator app, short enough to stay fresh

export const MFA_LOGIN_KEY = 'mcmf.mfa.login'; // pending 2FA login challenge
export const MFA_SETUP_KEY = 'mcmf.mfa.setup'; // pending 2FA enrolment secret

export function stashMfa<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ v: value, ts: Date.now() }));
  } catch {
    /* storage unavailable (private mode / quota) — degrade gracefully */
  }
}

export function readMfa<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw) as { v: T; ts: number };
    if (!o || typeof o.ts !== 'number' || Date.now() - o.ts > TTL_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return o.v;
  } catch {
    return null;
  }
}

export function clearMfa(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
