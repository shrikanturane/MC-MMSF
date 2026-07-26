/**
 * Motion-gated capture — the arithmetic behind "only record when something actually happened". Pure.
 *
 * The target agent hashes each grab and simply does not upload a frame identical to the one before it.
 * Most support sessions are mostly still: a dialog on screen while the operator reads it produces the
 * same pixels 10 times a second, and uploading + encoding all ten is pure waste.
 *
 * That creates a timing problem the server has to solve. If the recorder wrote only the frames it
 * received, a 20-minute session with 3 minutes of movement would play back in 3 minutes and every
 * timestamp in it would be a lie — useless as evidence of what was done on someone's computer. So the
 * recorder PADS: when no new frame arrives it re-writes the previous one at the target frame rate.
 * Repeated frames cost almost nothing in H.264 (a still second is a few hundred bytes against tens of
 * kilobytes for a moving one), so the recording stays wall-clock accurate AND much smaller.
 *
 * The saving is therefore real but it is a saving on MOTION, not on duration — `savingsPct` reports what
 * was actually skipped rather than an estimate, so the storage panel never overstates it.
 */

/** Frames to synthesise to cover the gap since the last write, at `fps`, capped so a stall cannot flood. */
export function padCount(lastWrittenAtMs: number, nowMs: number, fps: number, maxPad = 20): number {
  if (!Number.isFinite(lastWrittenAtMs) || !Number.isFinite(nowMs) || fps <= 0) return 0;
  const due = Math.floor(((nowMs - lastWrittenAtMs) * fps) / 1000);
  if (due <= 1) return 0; // one interval late is just jitter, not a gap
  return Math.min(due - 1, maxPad);
}

/**
 * Share of frames the target never had to send. `skipped` comes from the agent (it counts its own
 * suppressed grabs); `sent` is what actually arrived. Returns 0 rather than NaN for an empty session.
 */
export function savingsPct(sent: number, skipped: number): number {
  const total = sent + skipped;
  if (total <= 0) return 0;
  return Math.round((skipped / total) * 1000) / 10;
}

/**
 * Is this grab worth sending? Mirrors the agent's rule so the policy has one written definition and one
 * test, even though the agent re-implements it in PowerShell (it cannot import TypeScript).
 *
 * A frame goes when the screen changed, or when the keep-alive is due.
 *
 * The keep-alive is also the WORST-CASE REFRESH RATE, which is why it is 300ms and not the 2s it
 * started at. Whenever change detection says "nothing moved" -- correctly or not -- the keep-alive is
 * the only thing still feeding the viewer, so 2s meant the operator watched a picture that updated
 * once every two seconds and looked frozen. At 300ms the worst case is a visibly live ~3fps, and a
 * genuinely still screen still costs a fraction of ungated capture.
 *
 * It matters for liveness too: `lastFrameAt` drives the idle ceiling, so a motionless target must not
 * look abandoned.
 */
export const KEEP_ALIVE_MS = 300;

export function shouldSendFrame(
  hash: number,
  lastHash: number | null,
  msSinceSent: number,
  keepAliveMs = KEEP_ALIVE_MS,
): boolean {
  if (lastHash === null || hash !== lastHash) return true;
  return msSinceSent >= keepAliveMs;
}
