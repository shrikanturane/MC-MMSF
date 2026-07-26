/**
 * Remote-console quality — a YouTube-style resolution ladder. Pure: a mode in, capture parameters out.
 *
 * The operator trades sharpness for responsiveness, and does it in the units everyone already knows from
 * video sites: 144p up to 1080p. Each rung sets three things that move together:
 *
 *   · maxHeight  — the target is downscaled so its HEIGHT fits this (a 1920x1080 desktop at "720p"
 *                  becomes 1280x720, exactly as a video would). Fewer pixels is the single biggest lever
 *                  on both bytes and the agent's encode time, which is what makes a bad link usable.
 *   · fps        — how often the screen is grabbed;
 *   · jpegQuality— the JPEG quality of each grab.
 *
 * The recording is made from whatever the agent sends, so choosing 720p records at 720p — the picture
 * an operator watches back matches the one they watched live, again like a video site.
 *
 * `144p` is the "works on a terrible link" floor; `1080p` is "the link is fine, make it sharp". The four
 * names the UI groups them under (min/medium/good/high) map onto rungs of this same ladder.
 */

export type QualityMode = '144p' | '240p' | '360p' | '480p' | '720p' | '1080p';

export interface QualityProfile {
  mode: QualityMode;
  fps: number;
  jpegQuality: number; // 1..100
  maxHeight: number; // downscale so the frame's height fits this; 0 = native
  /** Which named tier this rung belongs to, for the grouped picker. */
  tier: 'min' | 'medium' | 'good' | 'high';
  label: string;
}

export const QUALITY_PROFILES: Record<QualityMode, QualityProfile> = {
  '144p': { mode: '144p', fps: 5, jpegQuality: 35, maxHeight: 144, tier: 'min', label: '144p — lowest bandwidth' },
  '240p': { mode: '240p', fps: 6, jpegQuality: 40, maxHeight: 240, tier: 'min', label: '240p — very low bandwidth' },
  '360p': { mode: '360p', fps: 8, jpegQuality: 45, maxHeight: 360, tier: 'medium', label: '360p — low bandwidth' },
  '480p': { mode: '480p', fps: 10, jpegQuality: 50, maxHeight: 480, tier: 'medium', label: '480p — balanced' },
  '720p': { mode: '720p', fps: 12, jpegQuality: 62, maxHeight: 720, tier: 'good', label: '720p HD — smooth' },
  '1080p': { mode: '1080p', fps: 15, jpegQuality: 75, maxHeight: 1080, tier: 'high', label: '1080p Full HD — sharpest' },
};

export const ALL_MODES: QualityMode[] = ['144p', '240p', '360p', '480p', '720p', '1080p'];

export const DEFAULT_QUALITY: QualityMode = '480p';

/** The named tier each rung the picker offers as a quick default. */
export const TIER_DEFAULT: Record<'min' | 'medium' | 'good' | 'high', QualityMode> = {
  min: '240p',
  medium: '480p',
  good: '720p',
  high: '1080p',
};

/** Coerce any untrusted value to a known mode, never throwing. Legacy names map onto the ladder. */
export function toQualityMode(v: unknown): QualityMode {
  const s = String(v ?? '').toLowerCase();
  if ((ALL_MODES as string[]).includes(s)) return s as QualityMode;
  if (s === 'min' || s === 'medium' || s === 'good' || s === 'high') return TIER_DEFAULT[s];
  return DEFAULT_QUALITY;
}

export function profileOf(mode: unknown): QualityProfile {
  return QUALITY_PROFILES[toQualityMode(mode)];
}

/**
 * Bytes/sec from a byte total over a wall-clock window. Returned in kbps for the UI, the unit an
 * operator judging a link thinks in. Guards a zero/backwards window rather than dividing by it.
 */
export function kbps(bytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || bytes <= 0) return 0;
  return Math.round((bytes * 8) / elapsedMs); // bytes*8 bits / ms == kilobits / s
}
