import { ALL_MODES, DEFAULT_QUALITY, kbps, profileOf, QUALITY_PROFILES, TIER_DEFAULT, toQualityMode } from './quality';

describe('quality ladder', () => {
  it('is the YouTube resolution ladder, ordered least to most bandwidth', () => {
    expect(ALL_MODES).toEqual(['144p', '240p', '360p', '480p', '720p', '1080p']);
    const h = ALL_MODES.map((m) => QUALITY_PROFILES[m].maxHeight);
    const fps = ALL_MODES.map((m) => QUALITY_PROFILES[m].fps);
    const q = ALL_MODES.map((m) => QUALITY_PROFILES[m].jpegQuality);
    // Every lever only ever increases up the ladder — a higher rung that sent less would mislead the
    // operator choosing it.
    expect([...h].sort((a, b) => a - b)).toEqual(h);
    expect([...fps].sort((a, b) => a - b)).toEqual(fps);
    expect([...q].sort((a, b) => a - b)).toEqual(q);
  });

  it('maps each rung to a named tier', () => {
    expect(QUALITY_PROFILES['144p'].tier).toBe('min');
    expect(QUALITY_PROFILES['480p'].tier).toBe('medium');
    expect(QUALITY_PROFILES['720p'].tier).toBe('good');
    expect(QUALITY_PROFILES['1080p'].tier).toBe('high');
  });
});

describe('toQualityMode', () => {
  it('accepts the resolution modes', () => {
    expect(toQualityMode('144p')).toBe('144p');
    expect(toQualityMode('1080P')).toBe('1080p');
  });

  it('maps the legacy tier names onto the ladder (backward compatible)', () => {
    expect(toQualityMode('min')).toBe(TIER_DEFAULT.min);
    expect(toQualityMode('medium')).toBe(TIER_DEFAULT.medium);
    expect(toQualityMode('good')).toBe(TIER_DEFAULT.good);
    expect(toQualityMode('high')).toBe(TIER_DEFAULT.high);
  });

  it('falls back to the default for anything else, never throwing', () => {
    expect(toQualityMode('4k')).toBe(DEFAULT_QUALITY);
    expect(toQualityMode(undefined)).toBe(DEFAULT_QUALITY);
    expect(toQualityMode(42)).toBe(DEFAULT_QUALITY);
  });
});

describe('profileOf', () => {
  it('returns the profile whose mode matches its key', () => {
    for (const m of ALL_MODES) expect(profileOf(m).mode).toBe(m);
  });

  it('downscales by height on every rung except native would exceed 1080', () => {
    for (const m of ALL_MODES) expect(profileOf(m).maxHeight).toBeGreaterThan(0);
    expect(profileOf('720p').maxHeight).toBe(720);
  });
});

describe('kbps', () => {
  it('converts bytes over a window to kilobits per second', () => {
    expect(kbps(125_000, 1000)).toBe(1000);
  });

  it('is 0, not NaN or Infinity, before any time has elapsed', () => {
    expect(kbps(1000, 0)).toBe(0);
    expect(kbps(0, 1000)).toBe(0);
    expect(kbps(1000, -5)).toBe(0);
  });
});
