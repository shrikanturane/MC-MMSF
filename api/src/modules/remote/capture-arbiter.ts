/**
 * Which component may stream a session — pure, no I/O.
 *
 * Two components on the target can produce frames, and they overlap by design:
 *
 *   · 'console' — the SYSTEM helper the service spawns into the physical console session. It follows the
 *                 input desktop, so it keeps working at the logon screen, the lock screen and the UAC
 *                 secure desktop. This is the one that makes "show me the main console" true.
 *   · 'tray'    — the interactive agent. It can only ever see the user's own desktop, and goes black the
 *                 moment the screen locks. It exists as a fallback for hosts where spawning a SYSTEM
 *                 process into the console session is refused.
 *
 * If both stream at once the operator sees the two sources fight, and — worse — both sets of frames land
 * in one recording, so the mp4 plays at double speed for that stretch. Exactly one source owns a session
 * at a time. 'console' outranks 'tray' because it is a strict superset of what 'tray' can see; a claim is
 * released after a short silence so a crashed capturer cannot lock a session out forever.
 */

export type CaptureSource = 'console' | 'tray';

export interface CaptureClaim {
  source: CaptureSource;
  /** epoch ms of the last frame accepted from this source */
  at: number;
}

/** A claim goes stale after this long without a frame. At 10 fps that is ~30 missed frames: long enough
 *  that a slow network never hands the session over, short enough that a crash frees it near-instantly. */
export const CLAIM_TTL_MS = 3_000;

export interface Arbitration {
  accept: boolean;
  /** The claim to store when accepted. */
  claim?: CaptureClaim;
  /** True when ownership actually moved between components — worth an audit line, and it tells a rejected
   *  agent to stop trying rather than restart its capture loop every few seconds. */
  handover: boolean;
  reason?: string;
}

export function arbitrate(
  claim: CaptureClaim | undefined,
  incoming: CaptureSource,
  now: number,
  ttlMs = CLAIM_TTL_MS,
): Arbitration {
  const renew: CaptureClaim = { source: incoming, at: now };

  if (!claim) return { accept: true, claim: renew, handover: false };
  if (claim.source === incoming) return { accept: true, claim: renew, handover: false };

  // The incumbent went quiet: it crashed, lost the desktop, or the box slept. Let the newcomer have it.
  if (now - claim.at >= ttlMs) {
    return { accept: true, claim: renew, handover: true, reason: `${claim.source} capture went silent` };
  }

  // Both live. The console helper sees everything the tray sees and more, so it takes over.
  if (incoming === 'console') {
    return { accept: true, claim: renew, handover: true, reason: 'console capture supersedes the tray (it survives lock/UAC/logon)' };
  }

  return {
    accept: false,
    handover: true,
    reason: 'the console capture helper owns this session — it can show the logon and lock screens, the tray cannot',
  };
}
