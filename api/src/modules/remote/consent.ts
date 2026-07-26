/**
 * Attended remote support — the pure session/consent state machine.
 *
 * Kept free of I/O and Date.now() (every timestamp is passed in) so the rules that decide whether an
 * operator may see someone's screen are deterministic, unit-testable and auditable. This is the part
 * that must be provably correct: it is the gate between "a support engineer asked" and "a corporate
 * desktop is being watched and recorded".
 *
 * Lifecycle
 *   requested ──agent-ack(interactive user)──> awaiting-consent ──user-accept──────> active ──> ended
 *        │                                            ├──user-decline──> declined
 *        │                                            └──timeout───────> active (autoAccepted)
 *        ├──agent-ack(no interactive user)───────────────────────────────> active (autoAccepted)
 *        └──agent-unreachable / expired ─────────────────────────────────> failed | expired
 */

export type SessionStatus =
  | 'requested'         // operator asked; agent not yet acknowledged
  | 'awaiting-consent'  // consent prompt is on the target's screen
  | 'active'            // streaming
  | 'ended'             // finished normally
  | 'declined'          // the person at the desk said no
  | 'expired'           // agent never acknowledged in time
  | 'failed';           // agent lost / error

export type ConsentState =
  | 'pending'
  | 'accepted'       // a human clicked Accept
  | 'declined'       // a human clicked Decline
  | 'auto-accepted'  // consent timed out — proceeded per policy, recorded as such
  | 'not-required';  // no interactive user to ask (headless/logged-out console)

export type SessionEvent =
  | { type: 'agent-ack'; interactiveUser: string | null } // agent reached the console; who (if anyone) is there
  | { type: 'user-accept'; user?: string }
  | { type: 'user-decline'; user?: string }
  | { type: 'tick' }          // clock moved — may expire a request or auto-accept a prompt
  | { type: 'operator-end' }
  | { type: 'agent-lost'; detail?: string };

export interface SessionState {
  status: SessionStatus;
  consent: ConsentState;
  autoAccepted: boolean;
  consentUser: string | null;
  endReason: string;
}

export interface SessionTimes {
  requestedAt: Date;
  promptedAt: Date | null; // when the consent dialog went up
  startedAt?: Date | null; // when streaming actually began (bounds the session ceiling)
  lastFrameAt?: Date | null; // last frame accepted (bounds the idle timeout)
}

export interface ConsentConfig {
  /** No answer within this many seconds → proceed anyway (policy: consent + timeout auto-accept). */
  consentTimeoutSec: number;
  /** Agent never acknowledged within this many seconds → expire the request (target likely offline). */
  agentAckTimeoutSec: number;
  /**
   * Ask the person at the console before streaming. FALSE = unattended support: the session goes
   * straight to active on the agent's ack and no prompt is shown. Intended for corporate-owned,
   * centrally-managed fleets where the org has already established the right to remote in.
   *
   * The consent machinery below is deliberately kept rather than deleted: flipping this back to true
   * restores prompting per-deployment, which some tenants/jurisdictions require. Whichever mode is in
   * force, the audit trail still records who connected, to which host, and why.
   */
  requireConsent: boolean;
  /**
   * Is the target a Windows SERVER OS (vs a Windows 10/11 client)? Only affects the no-answer timeout:
   * a server auto-approves after the window (a headless/managed box nobody may be sitting at), but a
   * CLIENT PC is cancelled instead — a person is expected to be there and must explicitly approve. Derived
   * from the agent's reported OS (`/server/i`); defaults false (unknown OS is treated as a client — stricter).
   */
  targetIsServer: boolean;
  /**
   * Hard ceiling on a single session, in seconds. An active session that nobody ends would otherwise
   * run forever: one was found still active after 167 hours, having taken 2.25M frames and filled a
   * 538 MB recording. That is the failure this bounds — and it matters far more once prompting is off,
   * because nothing on the target announces that capture is still running.
   */
  maxSessionSec: number;
  /**
   * End an active session after this long with no frames arriving (operator closed the tab, agent died,
   * network dropped). Distinct from maxSessionSec: this catches abandonment, that catches overrun.
   */
  idleTimeoutSec: number;
  /** How many sessions may stream at once across the whole platform. */
  maxConcurrent: number;
}

export const DEFAULT_CONSENT: ConsentConfig = {
  consentTimeoutSec: 180, // 3 min for a human to accept (servers auto-approve after this; clients are cancelled)
  agentAckTimeoutSec: 60,
  requireConsent: false, // unattended by default: corporate-managed fleet
  targetIsServer: false, // unknown OS → treat as a client (stricter: no auto-approve on timeout)
  // 8h. This is the ABANDONMENT backstop, not the recording length: recordings roll to a new file every
  // 4 hours (see retention.maxFileHours), and a ceiling of 2h meant a long support session was cut off
  // before a second file could ever exist.
  maxSessionSec: 8 * 60 * 60,
  // Each live session costs one ffmpeg encoder plus a frame in memory, so this is a real resource
  // limit, not a licence check. 15 is the supported figure; raise it only alongside CPU headroom,
  // because the encoders are what saturate first.
  maxConcurrent: 15,
  idleTimeoutSec: 120, // 2 min without a frame
};

const TERMINAL: SessionStatus[] = ['ended', 'declined', 'expired', 'failed'];
export const isTerminal = (s: SessionStatus): boolean => TERMINAL.includes(s);

export const initialState = (): SessionState => ({
  status: 'requested',
  consent: 'pending',
  autoAccepted: false,
  consentUser: null,
  endReason: '',
});

/** Seconds remaining before the consent prompt auto-accepts. null when no prompt is pending. */
export function consentSecondsLeft(
  state: SessionState,
  times: SessionTimes,
  now: Date,
  cfg: ConsentConfig = DEFAULT_CONSENT,
): number | null {
  if (state.status !== 'awaiting-consent' || !times.promptedAt) return null;
  const elapsed = (now.getTime() - times.promptedAt.getTime()) / 1000;
  return Math.max(0, Math.ceil(cfg.consentTimeoutSec - elapsed));
}

/**
 * Apply an event. Pure: same (state, event, times, now) always yields the same next state. Events that
 * don't apply to the current status are ignored (returns the state unchanged) rather than throwing —
 * a late Accept after a decline must never resurrect a session.
 */
export function reduce(
  state: SessionState,
  event: SessionEvent,
  times: SessionTimes,
  now: Date,
  cfg: ConsentConfig = DEFAULT_CONSENT,
): SessionState {
  if (isTerminal(state.status)) return state; // terminal is forever

  switch (event.type) {
    case 'agent-ack': {
      if (state.status !== 'requested') return state;
      // Unattended mode: no prompt at all. Still record who was at the console, so the audit line says
      // whose desktop was captured even though they were never asked.
      if (!cfg.requireConsent) {
        return { ...state, status: 'active', consent: 'not-required', autoAccepted: true, consentUser: event.interactiveUser ?? null };
      }
      // Nobody at the console → nobody to ask. Proceed, but record WHY consent was skipped.
      if (!event.interactiveUser) {
        return { ...state, status: 'active', consent: 'not-required', autoAccepted: true, consentUser: null };
      }
      return { ...state, status: 'awaiting-consent', consent: 'pending', consentUser: event.interactiveUser };
    }

    case 'user-accept': {
      if (state.status !== 'awaiting-consent') return state;
      return { ...state, status: 'active', consent: 'accepted', autoAccepted: false, consentUser: event.user ?? state.consentUser };
    }

    case 'user-decline': {
      if (state.status !== 'awaiting-consent') return state;
      return { ...state, status: 'declined', consent: 'declined', autoAccepted: false, consentUser: event.user ?? state.consentUser, endReason: 'declined by the user at the console' };
    }

    case 'tick': {
      if (state.status === 'requested') {
        const waited = (now.getTime() - times.requestedAt.getTime()) / 1000;
        if (waited >= cfg.agentAckTimeoutSec) {
          return { ...state, status: 'expired', endReason: `agent did not respond within ${cfg.agentAckTimeoutSec}s` };
        }
        return state;
      }
      if (state.status === 'awaiting-consent') {
        const left = consentSecondsLeft(state, times, now, cfg);
        if (left !== null && left <= 0) {
          // No answer within the window. OS-differentiated: a SERVER auto-approves (nobody may be sitting
          // at a managed/headless box), but a CLIENT PC (Windows 10/11) is CANCELLED — a person is expected
          // to be there and must explicitly approve. Neither is ever called "accepted".
          if (cfg.targetIsServer) {
            return { ...state, status: 'active', consent: 'auto-accepted', autoAccepted: true };
          }
          return {
            ...state,
            status: 'expired',
            consent: 'pending',
            autoAccepted: false,
            endReason: `the user did not accept within ${Math.round(cfg.consentTimeoutSec / 60)} minutes — Windows 10/11 client PCs require explicit approval; request cancelled`,
          };
        }
        return state;
      }
      if (state.status === 'active') {
        // Two independent ceilings on a live session. Without these an active session runs until
        // someone remembers to close it — observed in the field at 167 hours and 2.25M frames.
        const since = (d: Date | null | undefined) => (d ? (now.getTime() - d.getTime()) / 1000 : null);
        const ran = since(times.startedAt);
        if (ran !== null && ran >= cfg.maxSessionSec) {
          return { ...state, status: 'ended', endReason: `session reached its ${Math.round(cfg.maxSessionSec / 60)}-minute maximum and was closed automatically` };
        }
        // Idle is measured from the last frame, falling back to start (a session that never streamed).
        const idle = since(times.lastFrameAt ?? times.startedAt);
        if (idle !== null && idle >= cfg.idleTimeoutSec) {
          return { ...state, status: 'ended', endReason: `no frames for ${Math.round(cfg.idleTimeoutSec)}s — session closed automatically (operator left or agent stopped)` };
        }
        return state;
      }
      return state;
    }

    case 'operator-end': {
      return { ...state, status: 'ended', endReason: 'ended by the operator' };
    }

    case 'agent-lost': {
      return { ...state, status: 'failed', endReason: event.detail || 'agent connection lost' };
    }

    default:
      return state;
  }
}

/** May frames be streamed/recorded right now? The single question the transport layer should ask. */
export const mayStream = (state: SessionState): boolean => state.status === 'active';

/**
 * How the session finished — written ONCE, on the terminal transition, and only when the consent
 * outcome was already recorded. Keeping this separate from auditLine() stops a session logging its
 * consent verdict twice (once when granted, again when it ended), which makes a review log unreadable.
 */
export function endLine(state: SessionState, operator: string, target: string, durationSec: number | null): string {
  const who = operator || 'unknown';
  switch (state.status) {
    case 'ended':
      return `${who} ended the remote session on ${target}${durationSec != null ? ` after ${durationSec}s` : ''}.`;
    case 'expired':
      return `${who}'s remote request for ${target} expired — ${state.endReason || 'the agent did not respond'}.`;
    case 'failed':
      return `${who}'s remote session on ${target} failed — ${state.endReason || 'connection lost'}.`;
    default:
      return `${who}'s remote session on ${target} is now ${state.status}.`;
  }
}

/**
 * One-line audit summary of the CONSENT outcome — this is what a compliance reviewer reads months
 * later, so it must state plainly whether a human actually agreed.
 */
export function auditLine(state: SessionState, operator: string, target: string): string {
  const who = state.consentUser ? `"${state.consentUser}"` : 'no interactive user';
  switch (state.consent) {
    case 'accepted':
      return `${operator} remoted ${target} — consent GRANTED by ${who}.`;
    case 'declined':
      return `${operator} requested remote of ${target} — consent DENIED by ${who}.`;
    case 'auto-accepted':
      return `${operator} remoted ${target} — consent prompt shown to ${who} but NOT answered; proceeded automatically per policy.`;
    case 'not-required':
      return `${operator} remoted ${target} — no interactive user at the console, so no consent prompt was possible; proceeded per policy.`;
    default:
      return `${operator} requested remote of ${target} — consent ${state.consent}, status ${state.status}.`;
  }
}
