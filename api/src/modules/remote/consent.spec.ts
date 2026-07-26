import {
  DEFAULT_CONSENT,
  auditLine,
  consentSecondsLeft,
  endLine,
  initialState,
  isTerminal,
  mayStream,
  reduce,
  type SessionState,
  type SessionTimes,
} from './consent';

// These suites describe behaviour when the deployment REQUIRES consent. That is no longer the default
// (unattended support is), so they opt in explicitly rather than relying on DEFAULT_CONSENT.
// ATTENDED targets a SERVER (auto-approves on timeout); ATTENDED_CLIENT a Windows 10/11 client (cancels).
const ATTENDED = { ...DEFAULT_CONSENT, requireConsent: true, targetIsServer: true };
const ATTENDED_CLIENT = { ...DEFAULT_CONSENT, requireConsent: true, targetIsServer: false };

const T0 = new Date('2026-07-15T10:00:00.000Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const times = (over: Partial<SessionTimes> = {}): SessionTimes => ({ requestedAt: T0, promptedAt: null, ...over });

/** Drive the machine through a list of events, threading state. */
const run = (events: Parameters<typeof reduce>[1][], t: SessionTimes, now = T0): SessionState =>
  events.reduce((s, e) => reduce(s, e, t, now, ATTENDED), initialState());

describe('remote support — consent state machine (pure)', () => {
  describe('the happy path', () => {
    test('agent acks with a user at the console → prompt goes up, nothing streams yet', () => {
      const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'CORP\\alice' }, times(), T0, ATTENDED);
      expect(s.status).toBe('awaiting-consent');
      expect(s.consentUser).toBe('CORP\\alice');
      expect(mayStream(s)).toBe(false);
    });

    test('user accepts → active, and it is recorded as a real human accept', () => {
      const t = times({ promptedAt: T0 });
      const s = run([{ type: 'agent-ack', interactiveUser: 'CORP\\alice' }, { type: 'user-accept' }], t);
      expect(s.status).toBe('active');
      expect(s.consent).toBe('accepted');
      expect(s.autoAccepted).toBe(false);
      expect(mayStream(s)).toBe(true);
    });

    test('operator ends → terminal', () => {
      const t = times({ promptedAt: T0 });
      const s = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-accept' }, { type: 'operator-end' }], t);
      expect(s.status).toBe('ended');
      expect(isTerminal(s.status)).toBe(true);
      expect(mayStream(s)).toBe(false);
    });
  });

  describe('consent is genuinely enforced', () => {
    test('NOTHING streams while consent is pending', () => {
      const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'u' }, times(), T0, ATTENDED);
      expect(mayStream(s)).toBe(false);
    });

    test('decline → declined, never streams', () => {
      const t = times({ promptedAt: T0 });
      const s = run([{ type: 'agent-ack', interactiveUser: 'CORP\\alice' }, { type: 'user-decline' }], t);
      expect(s.status).toBe('declined');
      expect(s.consent).toBe('declined');
      expect(mayStream(s)).toBe(false);
    });

    test('a late accept CANNOT resurrect a declined session', () => {
      const t = times({ promptedAt: T0 });
      const declined = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-decline' }], t);
      const after = reduce(declined, { type: 'user-accept' }, t, at(5), ATTENDED);
      expect(after.status).toBe('declined');
      expect(mayStream(after)).toBe(false);
    });

    test('terminal states are forever — no event reopens them', () => {
      const t = times({ promptedAt: T0 });
      const ended = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-accept' }, { type: 'operator-end' }], t);
      for (const e of [{ type: 'user-accept' } as const, { type: 'agent-ack', interactiveUser: 'u' } as const, { type: 'tick' } as const]) {
        expect(reduce(ended, e, t, at(99), ATTENDED).status).toBe('ended');
      }
    });
  });

  describe('timeout auto-accept (the chosen policy)', () => {
    test('no answer within the window → proceeds, but is NEVER labelled accepted', () => {
      const t = times({ promptedAt: T0 });
      const prompted = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'CORP\\alice' }, t, T0, ATTENDED);
      const s = reduce(prompted, { type: 'tick' }, t, at(DEFAULT_CONSENT.consentTimeoutSec), ATTENDED);
      expect(s.status).toBe('active');
      expect(s.consent).toBe('auto-accepted'); // distinct from 'accepted' — the audit must show nobody answered
      expect(s.autoAccepted).toBe(true);
      expect(s.consentUser).toBe('CORP\\alice'); // we still know who was ignored
    });

    test('a tick BEFORE the timeout does not auto-accept', () => {
      const t = times({ promptedAt: T0 });
      const prompted = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'u' }, t, T0, ATTENDED);
      const s = reduce(prompted, { type: 'tick' }, t, at(DEFAULT_CONSENT.consentTimeoutSec - 1), ATTENDED);
      expect(s.status).toBe('awaiting-consent');
      expect(mayStream(s)).toBe(false);
    });

    test('declining just before the timeout wins over the timeout', () => {
      const t = times({ promptedAt: T0 });
      const prompted = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'u' }, t, T0, ATTENDED);
      const declined = reduce(prompted, { type: 'user-decline' }, t, at(29), ATTENDED);
      const after = reduce(declined, { type: 'tick' }, t, at(60), ATTENDED);
      expect(after.status).toBe('declined');
    });

    test('SERVER: no answer within the window auto-approves', () => {
      const t = times({ promptedAt: T0 });
      const prompted = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'u' }, t, T0, ATTENDED);
      const s = reduce(prompted, { type: 'tick' }, t, at(DEFAULT_CONSENT.consentTimeoutSec), ATTENDED);
      expect(s.status).toBe('active');
      expect(s.consent).toBe('auto-accepted');
    });

    test('CLIENT (Win 10/11): no answer within the window CANCELS the request — never auto-approves', () => {
      const t = times({ promptedAt: T0 });
      const prompted = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'CORP\\alice' }, t, T0, ATTENDED_CLIENT);
      const s = reduce(prompted, { type: 'tick' }, t, at(DEFAULT_CONSENT.consentTimeoutSec), ATTENDED_CLIENT);
      expect(s.status).toBe('expired');
      expect(s.consent).toBe('pending'); // nobody accepted
      expect(s.autoAccepted).toBe(false);
      expect(mayStream(s)).toBe(false);
      expect(s.endReason).toMatch(/client PCs require explicit approval/i);
    });

    test('CLIENT: an explicit accept before the window still starts the session', () => {
      const t = times({ promptedAt: T0 });
      const s = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-accept' }], t);
      expect(s.status).toBe('active');
      expect(s.consent).toBe('accepted');
    });

    test('the 3-minute window is the default', () => {
      expect(DEFAULT_CONSENT.consentTimeoutSec).toBe(180);
    });

    test('countdown reports the seconds left, and null when no prompt is up', () => {
      const t = times({ promptedAt: T0 });
      const prompted = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'u' }, t, T0, ATTENDED);
      expect(consentSecondsLeft(prompted, t, at(10))).toBe(170); // 180s window − 10s elapsed
      expect(consentSecondsLeft(prompted, t, at(999))).toBe(0);
      expect(consentSecondsLeft(initialState(), times(), T0)).toBeNull();
    });
  });

  describe('headless / logged-out console', () => {
    test('no interactive user → no prompt is possible, proceeds as not-required', () => {
      const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: null }, times(), T0, ATTENDED);
      expect(s.status).toBe('active');
      expect(s.consent).toBe('not-required');
      expect(s.autoAccepted).toBe(true);
      expect(s.consentUser).toBeNull();
      expect(mayStream(s)).toBe(true);
    });
  });

  describe('failure paths', () => {
    test('agent never acks → expired after the ack timeout', () => {
      const s = reduce(initialState(), { type: 'tick' }, times(), at(DEFAULT_CONSENT.agentAckTimeoutSec), ATTENDED);
      expect(s.status).toBe('expired');
      expect(s.endReason).toMatch(/did not respond/);
    });

    test('a tick before the ack timeout leaves it requested', () => {
      expect(reduce(initialState(), { type: 'tick' }, times(), at(10), ATTENDED).status).toBe('requested');
    });

    test('agent lost mid-session → failed, streaming stops', () => {
      const t = times({ promptedAt: T0 });
      const active = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-accept' }], t);
      const s = reduce(active, { type: 'agent-lost', detail: 'tunnel closed' }, t, at(120), ATTENDED);
      expect(s.status).toBe('failed');
      expect(s.endReason).toBe('tunnel closed');
      expect(mayStream(s)).toBe(false);
    });
  });

  describe('audit trail states plainly whether a human agreed', () => {
    const t = times({ promptedAt: T0 });
    test('granted', () => {
      const s = run([{ type: 'agent-ack', interactiveUser: 'CORP\\alice' }, { type: 'user-accept' }], t);
      expect(auditLine(s, 'admin@x', 'HOST-01')).toMatch(/consent GRANTED by "CORP\\alice"/);
    });
    test('denied', () => {
      const s = run([{ type: 'agent-ack', interactiveUser: 'CORP\\alice' }, { type: 'user-decline' }], t);
      expect(auditLine(s, 'admin@x', 'HOST-01')).toMatch(/consent DENIED/);
    });
    test('auto-accepted says NOT answered — not "granted"', () => {
      const prompted = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'CORP\\alice' }, t, T0, ATTENDED);
      const s = reduce(prompted, { type: 'tick' }, t, at(DEFAULT_CONSENT.consentTimeoutSec), ATTENDED);
      const line = auditLine(s, 'admin@x', 'HOST-01');
      expect(line).toMatch(/NOT answered/);
      expect(line).not.toMatch(/GRANTED/);
    });
    test('headless says no prompt was possible', () => {
      const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: null }, times(), T0, ATTENDED);
      expect(auditLine(s, 'admin@x', 'srv-01')).toMatch(/no interactive user/);
    });
  });

  describe('endLine — how it finished, kept separate from the consent verdict', () => {
    const t = times({ promptedAt: T0 });
    test('ended reports the operator + duration, and does NOT repeat the consent verdict', () => {
      const s = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-accept' }, { type: 'operator-end' }], t);
      const line = endLine(s, 'admin@x', 'HOST-01', 42);
      expect(line).toMatch(/ended the remote session on HOST-01 after 42s/);
      expect(line).not.toMatch(/GRANTED|consent/i); // the verdict is logged once, by auditLine
    });

    test('expired surfaces the real reason instead of "consent pending"', () => {
      const s = reduce(initialState(), { type: 'tick' }, times(), at(DEFAULT_CONSENT.agentAckTimeoutSec), ATTENDED);
      expect(endLine(s, 'admin@x', 'srv-01', null)).toMatch(/expired — agent did not respond/);
    });

    test('failed surfaces the failure detail', () => {
      const active = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-accept' }], t);
      const s = reduce(active, { type: 'agent-lost', detail: 'tunnel closed' }, t, at(9), ATTENDED);
      expect(endLine(s, 'admin@x', 'srv-01', 9)).toMatch(/failed — tunnel closed/);
    });
  });

  test('is deterministic — same inputs, same output', () => {
    const t = times({ promptedAt: T0 });
    const a = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-accept' }], t);
    const b = run([{ type: 'agent-ack', interactiveUser: 'u' }, { type: 'user-accept' }], t);
    expect(a).toEqual(b);
  });
});

describe('unattended mode (no permission prompt)', () => {
  const UNATTENDED = { ...DEFAULT_CONSENT, requireConsent: false };

  test('the default deployment is unattended — no prompt is raised', () => {
    expect(DEFAULT_CONSENT.requireConsent).toBe(false);
  });

  test('agent ack goes STRAIGHT to active — nothing is asked', () => {
    const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'CORP\alice' }, times(), T0, UNATTENDED);
    expect(s.status).toBe('active');
    expect(s.consent).toBe('not-required');
    expect(mayStream(s)).toBe(true);
  });

  test('it still records WHOSE desktop was captured, even though nobody was asked', () => {
    // With no prompt, the signed-in user is the only accountability left. It must not be dropped.
    const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'CORP\alice' }, times(), T0, UNATTENDED);
    expect(s.consentUser).toBe('CORP\alice');
  });

  test('it is never labelled "accepted" — no human agreed to anything', () => {
    const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'CORP\alice' }, times(), T0, UNATTENDED);
    expect(s.consent).not.toBe('accepted');
    expect(auditLine(s, 'admin@x', 'HOST')).not.toMatch(/GRANTED/);
  });

  test('a logged-out console is handled the same way', () => {
    const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: null }, times(), T0, UNATTENDED);
    expect(s.status).toBe('active');
    expect(s.consentUser).toBeNull();
  });

  test('REGRESSION: flipping requireConsent back on restores prompting', () => {
    const s = reduce(initialState(), { type: 'agent-ack', interactiveUser: 'CORP\alice' }, times(), T0,
      { ...DEFAULT_CONSENT, requireConsent: true });
    expect(s.status).toBe('awaiting-consent');
    expect(mayStream(s)).toBe(false);
  });
});

describe('active-session ceilings (the 167-hour session that actually happened)', () => {
  const CFG = { ...DEFAULT_CONSENT, requireConsent: false, maxSessionSec: 7200, idleTimeoutSec: 120 };
  const active = (): SessionState =>
    reduce(initialState(), { type: 'agent-ack', interactiveUser: 'u' }, times(), T0, CFG);

  test('THE BUG: a live session is closed once it hits the maximum duration', () => {
    // A session was found still active after 167 hours, 2.25M frames and a 538MB recording, because
    // nothing ever ended it. That must now be impossible.
    const t = times({ startedAt: T0, lastFrameAt: at(7200) });
    const s = reduce(active(), { type: 'tick' }, t, at(7200), CFG);
    expect(s.status).toBe('ended');
    expect(s.endReason).toMatch(/maximum/);
  });

  test('a session still inside the maximum keeps running', () => {
    const t = times({ startedAt: T0, lastFrameAt: at(7199) });
    expect(reduce(active(), { type: 'tick' }, t, at(7199), CFG).status).toBe('active');
  });

  test('an abandoned session (no frames) is closed by the idle ceiling', () => {
    const t = times({ startedAt: T0, lastFrameAt: at(10) });
    const s = reduce(active(), { type: 'tick' }, t, at(130), CFG);
    expect(s.status).toBe('ended');
    expect(s.endReason).toMatch(/no frames/);
  });

  test('a session streaming steadily is never idle-closed', () => {
    let s = active();
    for (let i = 1; i <= 60; i++) {
      const now = at(i * 60);
      s = reduce(s, { type: 'tick' }, times({ startedAt: T0, lastFrameAt: now }), now, CFG);
      expect(s.status).toBe('active');
    }
  });

  test('a session that never streamed at all still gets closed', () => {
    // lastFrameAt null → idle is measured from start, so a session that never produced a frame
    // cannot sit active forever either.
    const t = times({ startedAt: T0, lastFrameAt: null });
    expect(reduce(active(), { type: 'tick' }, t, at(200), CFG).status).toBe('ended');
  });

  test('the ceilings never resurrect a terminal session', () => {
    const ended = reduce(active(), { type: 'operator-end' }, times({ startedAt: T0 }), at(5), CFG);
    const s = reduce(ended, { type: 'tick' }, times({ startedAt: T0, lastFrameAt: T0 }), at(99999), CFG);
    expect(s.status).toBe('ended');
    expect(s.endReason).toMatch(/operator/);
  });
});

describe('concurrency limit', () => {
  // A real resource limit: every live session holds an ffmpeg encoder. Without a ceiling the failure
  // mode is not one slow session, it is every session stuttering with nothing explaining why.
  it('defaults to 15 concurrent sessions', () => {
    expect(DEFAULT_CONSENT.maxConcurrent).toBe(15);
  });
});
