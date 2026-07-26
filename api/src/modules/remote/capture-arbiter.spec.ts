import { arbitrate, CLAIM_TTL_MS, type CaptureClaim } from './capture-arbiter';

const T = 1_000_000;

describe('capture arbitration — exactly one source per session', () => {
  test('an unclaimed session is granted to whoever asks first', () => {
    const r = arbitrate(undefined, 'tray', T);
    expect(r.accept).toBe(true);
    expect(r.claim).toEqual({ source: 'tray', at: T });
    expect(r.handover).toBe(false);
  });

  test('the owner renews its own claim on every frame', () => {
    const claim: CaptureClaim = { source: 'console', at: T };
    const r = arbitrate(claim, 'console', T + 100);
    expect(r.accept).toBe(true);
    expect(r.claim!.at).toBe(T + 100); // without the renew, the owner would time itself out
    expect(r.handover).toBe(false);
  });

  test('the console helper takes a live session off the tray', () => {
    // The real sequence: the tray sees the session first (3s poll) and starts; the SYSTEM helper the
    // service spawned arrives a moment later. The helper must win — it is the one that survives a lock.
    const r = arbitrate({ source: 'tray', at: T }, 'console', T + 500);
    expect(r.accept).toBe(true);
    expect(r.handover).toBe(true);
    expect(r.reason).toMatch(/supersedes/);
  });

  test('the tray does NOT get a session back off a live console helper', () => {
    const r = arbitrate({ source: 'console', at: T }, 'tray', T + 500);
    expect(r.accept).toBe(false);
    expect(r.handover).toBe(true); // tells the tray to stop, not to retry every 3s
  });

  test('a crashed capturer releases the session after the TTL', () => {
    const r = arbitrate({ source: 'console', at: T }, 'tray', T + CLAIM_TTL_MS);
    expect(r.accept).toBe(true);
    expect(r.reason).toMatch(/went silent/);
  });

  test('a claim one millisecond inside the TTL still holds', () => {
    // Off-by-one here means a slow network hands the session back and forth mid-recording.
    const r = arbitrate({ source: 'console', at: T }, 'tray', T + CLAIM_TTL_MS - 1);
    expect(r.accept).toBe(false);
  });

  test('a lagging tray frame cannot interrupt the console mid-session', () => {
    let claim: CaptureClaim | undefined = undefined;
    // console streaming steadily at 10fps
    for (let i = 0; i < 30; i++) {
      const r = arbitrate(claim, 'console', T + i * 100);
      expect(r.accept).toBe(true);
      claim = r.claim;
    }
    // a stray tray frame arrives in the middle
    expect(arbitrate(claim, 'tray', T + 3_050).accept).toBe(false);
  });

  test('handover is only reported when ownership actually moves', () => {
    expect(arbitrate(undefined, 'console', T).handover).toBe(false);
    expect(arbitrate({ source: 'tray', at: T }, 'tray', T + 100).handover).toBe(false);
  });
});
