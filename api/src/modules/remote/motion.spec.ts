import { padCount, savingsPct, shouldSendFrame } from './motion';

describe('padCount', () => {
  it('pads nothing when the frame arrived on time', () => {
    expect(padCount(1_000, 1_100, 10)).toBe(0); // exactly one interval
    expect(padCount(1_000, 1_150, 10)).toBe(0); // jitter, not a gap
  });

  it('fills a still stretch so the recording stays wall-clock accurate', () => {
    // 1s of silence at 10fps = 10 intervals; one of them is the frame itself.
    expect(padCount(1_000, 2_000, 10)).toBe(9);
  });

  it('caps the fill so a stalled event loop cannot flood the encoder', () => {
    expect(padCount(0, 60_000, 10)).toBe(20);
    expect(padCount(0, 60_000, 10, 5)).toBe(5);
  });

  it('returns 0 for nonsense rather than throwing into the recording path', () => {
    expect(padCount(NaN, 1_000, 10)).toBe(0);
    expect(padCount(0, 1_000, 0)).toBe(0);
  });
});

describe('savingsPct', () => {
  it('reports what was actually skipped', () => {
    expect(savingsPct(100, 900)).toBe(90);
    expect(savingsPct(100, 0)).toBe(0);
  });

  it('is 0, not NaN, for a session that never streamed', () => {
    expect(savingsPct(0, 0)).toBe(0);
  });
});

describe('shouldSendFrame', () => {
  it('sends the first frame, and any frame whose pixels changed', () => {
    expect(shouldSendFrame(123, null, 0)).toBe(true);
    expect(shouldSendFrame(124, 123, 0)).toBe(true);
  });

  it('suppresses an identical frame', () => {
    expect(shouldSendFrame(123, 123, 100)).toBe(false);
  });

  // Without this, a motionless desktop looks abandoned to the idle ceiling and the session gets closed
  // out from under the operator.
  // The keep-alive doubles as the worst-case refresh rate: when detection says nothing moved, it is
  // the only thing feeding the viewer. At 2s that looked frozen to the operator.
  it('still sends a keep-alive on a motionless screen, fast enough to look live', () => {
    expect(shouldSendFrame(123, 123, 300)).toBe(true);
    expect(shouldSendFrame(123, 123, 299)).toBe(false);
  });

  it('honours an explicit keep-alive override', () => {
    expect(shouldSendFrame(123, 123, 500, 1_000)).toBe(false);
    expect(shouldSendFrame(123, 123, 1_000, 1_000)).toBe(true);
  });
});
