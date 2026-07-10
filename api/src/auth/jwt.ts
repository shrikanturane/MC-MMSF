import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stable signing secret — reuses APP_ENCRYPTION_KEY (already set + stable) unless AUTH_SECRET is given.
 *  No constant fallback: startup fails closed (main.ts checkSecrets) if neither is a strong value. */
function secret(): string {
  // Non-empty is enforced here; strength of the primary key (APP_ENCRYPTION_KEY, 32+ chars) is
  // gated once at startup in main.ts checkSecrets(). No committed constant fallback.
  const s = process.env.AUTH_SECRET || process.env.APP_ENCRYPTION_KEY;
  if (!s) throw new Error('AUTH_SECRET/APP_ENCRYPTION_KEY not set. Generate: openssl rand -hex 32');
  return s;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface JwtPayload {
  sub: string; // user id
  role: 'admin' | 'operator' | 'viewer';
  name: string;
  email: string;
  jti?: string; // session id (for revocation / session management)
  scope?: string; // '2fa' = pre-auth challenge (not a full session)
  iat?: number;
  exp?: number;
}

/** Sign a minimal HS256 JWT (no external dependency). Default TTL 12h. */
export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, ttlSec = 60 * 60 * 12): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  const sig = createHmac('sha256', secret()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  const [h, b, s] = (token || '').split('.');
  if (!h || !b || !s) return null;
  const expected = createHmac('sha256', secret()).update(`${h}.${b}`).digest('base64url');
  if (!safeEq(s, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) as JwtPayload;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
