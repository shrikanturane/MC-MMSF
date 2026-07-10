'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost, TOKEN_KEY } from './api';
import type { Role } from './types';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  contact?: string;
  sessionId?: string | null;
  twoFactorEnabled?: boolean;
  twoFactorRequired?: boolean; // role-based mandatory-2FA enrolment gate (operator/viewer)
  access?: import('./modules').UserAccess; // group-based effective access (admin → full)
}

export type LoginResult = { token: string; user: AuthUser } | { twoFactorRequired: true; challenge: string };

export interface SessionItem {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export function setToken(t: string) {
  window.localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}
export function hasToken(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage.getItem(TOKEN_KEY);
}

/** Current identity from the token; errors (401) → not authenticated. */
export const useAuthUser = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => apiGet<AuthUser>('/auth/me'),
    retry: false,
    staleTime: Infinity,
    refetchInterval: false,
  });

export const useLogin = () =>
  useMutation({
    mutationFn: (body: { email: string; password: string; remember?: boolean }) =>
      apiPost<LoginResult>('/auth/login', body),
  });

export const useSsoProviders = () =>
  useQuery({ queryKey: ['sso-providers'], queryFn: () => apiGet<{ google: boolean; microsoft: boolean }>('/auth/sso/providers'), staleTime: Infinity, retry: false });

export const useVerify2fa = () =>
  useMutation({
    mutationFn: (body: { challenge: string; code: string; remember?: boolean }) =>
      apiPost<{ token: string; user: AuthUser }>('/auth/2fa/verify', body),
  });
export const useEmailOtp = () =>
  useMutation({
    mutationFn: (body: { challenge: string }) => apiPost<{ sent: boolean; to: string }>('/auth/2fa/email-otp', body),
  });

// 2FA enrollment (authenticated)
export const useSetup2fa = () => useMutation({ mutationFn: () => apiPost<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup') });
export const useEnable2fa = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (code: string) => apiPost<{ ok: boolean; recoveryCodes: string[] }>('/auth/2fa/enable', { code }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
};
export const useDisable2fa = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (code: string) => apiPost<{ ok: boolean }>('/auth/2fa/disable', { code }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
};

export const useForgotPassword = () =>
  useMutation({
    mutationFn: (body: { email: string }) => apiPost<{ ok: boolean; emailConfigured: boolean }>('/auth/forgot', body),
  });

export const useResetPassword = () =>
  useMutation({
    mutationFn: (body: { token: string; newPassword: string }) => apiPost<{ ok: boolean }>('/auth/reset', body),
  });

export const useForgot2fa = () =>
  useMutation({ mutationFn: (body: { email: string }) => apiPost<{ ok: boolean; emailConfigured: boolean }>('/auth/2fa/forgot', body) });
export const useReset2faToken = () =>
  useMutation({ mutationFn: (body: { token: string }) => apiPost<{ ok: boolean; email: string }>('/auth/2fa/reset-token', body) });

/** Active login sessions for the current user. */
export const useSessions = () =>
  useQuery({ queryKey: ['sessions'], queryFn: () => apiGet<SessionItem[]>('/auth/sessions'), refetchInterval: 30000 });

export const useRevokeSession = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
};

/** Self-service password change for the logged-in user. */
export const useChangeMyPassword = () =>
  useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      apiPost<{ ok: boolean }>('/auth/password', body),
  });

/** Admin-only security audit trail. */
export const useAudit = (action?: string) =>
  useQuery({
    queryKey: ['audit', action ?? 'all'],
    queryFn: () => apiGet<import('./types').AuditEntry[]>(`/audit${action ? `?action=${action}` : ''}`),
    refetchInterval: 20000,
  });

export function logout() {
  // Best-effort audit of the logout, then clear and bounce to the gate.
  apiPost('/auth/logout').catch(() => undefined).finally(() => {
    clearToken();
    window.location.href = '/';
  });
}

/** Convenience permission helpers mirroring the backend RBAC matrix. */
export const canWrite = (role?: Role) => role === 'admin' || role === 'operator';
export const isAdmin = (role?: Role) => role === 'admin';
