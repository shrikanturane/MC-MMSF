import { timingSafeEqual } from 'node:crypto';

/**
 * Who may speak for the target machine on a remote-support session (ack, consent answer, frames).
 *
 * These routes are @Public because the agent has no user session — but they must still prove they ARE
 * the session's agent. Otherwise anyone holding a session id (every operator who requested one) could
 * answer the consent prompt themselves, or ack with "nobody at the console" to skip it entirely.
 *
 * Pure: the caller loads the session's agent row and passes what it found.
 */

/** First agent build that presents its key on the remote-session routes. */
export const REMOTE_AUTH_MIN_AGENT_VERSION = '1.20.15';

export type AgentAuthVerdict = 'ok' | 'legacy' | 'deny';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  return ab.length > 0 && ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Dotted numeric compare: is `v` >= `min`? Unparseable versions are treated as NOT older (strict). */
export function isOlderThan(v: string | null | undefined, min: string): boolean {
  if (!v) return false;
  const pa = String(v).split('.').map((x) => Number.parseInt(x, 10));
  const pb = min.split('.').map((x) => Number.parseInt(x, 10));
  if (pa.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] ?? 0;
    const b = pb[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * - A presented key must be the shared bootstrap key or THIS agent's own token — anything else is denied.
 * - No key: allowed ('legacy') only for an agent that last reported a build older than the one that
 *   started sending keys, so the fleet keeps working until it self-updates; unless strict mode is on.
 *   An agent on a current (or unknown) build that omits its key is denied.
 */
export function decideAgentAuth(input: {
  presentedKey: string;
  sharedKey: string;
  agentToken: string | null | undefined;
  agentVersion: string | null | undefined;
  strict?: boolean;
}): AgentAuthVerdict {
  const k = String(input.presentedKey || '').trim();
  if (k) {
    if (safeEq(k, input.sharedKey)) return 'ok';
    if (input.agentToken && safeEq(k, input.agentToken)) return 'ok';
    return 'deny';
  }
  if (!input.strict && isOlderThan(input.agentVersion, REMOTE_AUTH_MIN_AGENT_VERSION)) return 'legacy';
  return 'deny';
}

/** Shared agent key — same derivation AgentService / AgentTunnelHub / RemoteMediaHub use. */
export function sharedAgentKey(): string {
  return (process.env.AGENT_KEY || String(process.env.APP_ENCRYPTION_KEY || '').slice(0, 24)).trim();
}
