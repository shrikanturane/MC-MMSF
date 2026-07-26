import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import { DEFAULT_FPS } from './fps';
import { padCount } from './motion';
import { fileOverAge, sessionOverCap, type RetentionConfig } from './retention';

/**
 * Session recording: JPEG frames in, H.264 out, SEGMENTED into fixed-size parts.
 *
 * Frames are piped straight into ffmpeg (image2pipe) and never written to disk as images. That is the
 * whole point: 10 fps of JPEG is ~500 MB per 15 minutes, and this platform has already taken production
 * down by filling a disk.
 *
 * A session no longer produces one unbounded file. When the current part reaches the per-file cap it is
 * finalised and the next one starts (`<id>-p1.mp4`, `<id>-p2.mp4`, …), so a long session yields several
 * playable files instead of one huge one — and, unlike the previous behaviour, recording CONTINUES past
 * the cap rather than silently stopping. Each part is closed properly (moov atom) so every one plays on
 * its own.
 *
 * Writing is CLOCK-DRIVEN, not arrival-driven. The target only uploads a frame when the screen actually
 * changed (see motion.ts), so feeding ffmpeg exactly what arrives would compress every still stretch and
 * hand back a recording whose timeline does not match the session it claims to document. Instead a timer
 * emits one frame per interval, repeating the last one when nothing new came in. Repeated frames are
 * nearly free in H.264, so the recording stays wall-clock honest and still gets much smaller.
 */
export const RECORDINGS_DIR = process.env.REMOTE_RECORDINGS_DIR || '/recordings';

/** How often to stat the growing part for the size cap. 50 frames is ~5s at 10fps. */
const CAP_CHECK_FRAMES = 50;

/** Parts are named so they sort naturally and are obviously one session's. */
export const partFile = (id: string, part: number): string => path.join(RECORDINGS_DIR, `${id}-p${part}.mp4`);

interface Rec {
  proc: ChildProcess;
  file: string;
  part: number;
  fps: number;
  /** Bytes of every part already finalised for this session (excludes the one being written). */
  closedBytes: number;
  frames: number;
  stopped: boolean;
  rolling: boolean;
  /** The clock that keeps the recording wall-clock accurate while the target stays silent. */
  timer: ReturnType<typeof setInterval> | null;
  /** Newest frame not yet encoded; null when the screen has not changed since the last tick. */
  pending: Buffer | null;
  /** Last frame encoded — repeated to fill still stretches. */
  last: Buffer | null;
  lastWriteAt: number;
  /** Frames synthesised from `last` because nothing new arrived. Reported for honesty about savings. */
  padded: number;
  /** When the CURRENT part was opened - drives the wall-clock roll. */
  partOpenedAt: number;
  /** Operator stopped recording mid-session. Frames keep flowing to the viewer; none are written. */
  paused: boolean;
}

export class Recorder {
  private readonly log = new Logger('RemoteRec');
  private recs = new Map<string, Rec>();

  constructor(private readonly cfg: () => RetentionConfig) {}

  private ensureDir() {
    try { fs.mkdirSync(RECORDINGS_DIR, { recursive: true }); } catch { /* surfaced on write */ }
  }

  /** True once ffmpeg is actually running for this session. */
  has(id: string): boolean {
    return this.recs.has(id);
  }

  /** Spawn ffmpeg for one part. Returns null if it could not start. */
  private spawnPart(id: string, part: number, fps: number): { proc: ChildProcess; file: string } | null {
    const file = partFile(id, part);
    try {
      // image2pipe: a stream of JPEGs on stdin -> H.264. -r on BOTH sides pins the timebase so the
      // recording plays back at wall-clock speed even when frames arrive unevenly over the network.
      const proc = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', '-r', String(fps), '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'faster',
        // NO -tune zerolatency here. It disables B-frames and lookahead, which is right for a live
        // stream but roughly doubles the size of a RECORDING for no benefit -- nobody watches the file
        // as it is written, so the encoder is free to look ahead.
        // CRF instead of a fixed bitrate: a desk that is mostly still costs almost nothing, while a
        // busy screen still gets the bits it needs. 30 is visually fine for screen content at <=720p.
        '-crf', '30',
        // One keyframe every ~10s instead of the default ~2s. Keyframes are the expensive frames, and a
        // screen recording rarely needs to be seekable at finer than 10s granularity.
        '-g', String(Math.max(30, fps * 10)),
        '-pix_fmt', 'yuv420p', // some players refuse 4:4:4 from JPEG input
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // libx264 needs even dimensions
        '-r', String(fps), '-movflags', '+faststart', '-y', file,
      ]);
      proc.on('error', (e) => { this.log.warn(`ffmpeg spawn failed (${id} p${part}): ${e.message} — recording disabled for this session`); this.recs.delete(id); });
      proc.stderr?.on('data', (d) => { const s = String(d).trim(); if (s) this.log.warn(`ffmpeg ${id} p${part}: ${s.slice(0, 200)}`); });
      // EPIPE after ffmpeg exits must not take the API down.
      proc.stdin?.on('error', () => undefined);
      return { proc, file };
    } catch (e) {
      this.log.warn(`recording unavailable for ${id}: ${String((e as Error)?.message ?? e)}`);
      return null;
    }
  }

  /** Close one ffmpeg and wait for the moov atom, so the part is playable on its own. */
  private async closeProc(proc: ChildProcess): Promise<void> {
    try { proc.stdin?.end(); } catch { /* already gone */ }
    await new Promise<void>((res) => {
      let done = false;
      const finish = () => { if (!done) { done = true; res(); } };
      proc.once('close', finish);
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } finish(); }, 15_000);
    });
  }

  private sizeOf(file: string): number {
    try { return fs.statSync(file).size; } catch { return 0; }
  }

  start(id: string, fps = DEFAULT_FPS): string | null {
    if (this.recs.has(id)) return this.recs.get(id)!.file;
    this.ensureDir();
    const p = this.spawnPart(id, 1, fps);
    if (!p) return null;
    const rec: Rec = {
      proc: p.proc, file: p.file, part: 1, fps, closedBytes: 0, frames: 0, stopped: false, rolling: false,
      timer: null, pending: null, last: null, lastWriteAt: Date.now(), padded: 0, paused: false,
      partOpenedAt: Date.now(),
    };
    rec.timer = setInterval(() => this.pump(id), Math.max(20, Math.round(1000 / fps)));
    this.recs.set(id, rec);
    this.log.log(`recording ${id} -> ${p.file} @ ${fps}fps (${this.cfg().maxSessionMb}MB per part)`);
    return p.file;
  }

  /**
   * Offer a frame. It is not encoded here — the pump decides when, so that a still screen still advances
   * the recording's clock. Returns false only when recording is not running for this session.
   */
  write(id: string, jpeg: Buffer): boolean {
    const r = this.recs.get(id);
    if (!r || r.stopped) return false;
    r.pending = jpeg;
    return true;
  }

  /**
   * One tick of the recording clock: encode the new frame if there is one, otherwise repeat the last.
   * Nothing is written before the first real frame — a session that never streamed produces no video
   * rather than a file full of black.
   */
  private pump(id: string) {
    const r = this.recs.get(id);
    if (!r || r.stopped || r.rolling || r.paused) return;
    const fresh = r.pending;
    const buf = fresh ?? r.last;
    if (!buf) return;
    r.pending = null;
    r.last = buf;
    // Cover any ticks the event loop missed (a busy API must not silently shorten the timeline), then
    // the frame itself.
    const repeats = fresh ? 0 : padCount(r.lastWriteAt, Date.now(), r.fps);
    const total = 1 + repeats;
    if (!fresh) r.padded += total;
    r.frames += total;
    r.lastWriteAt = Date.now();
    // Roll to the next part once the CURRENT FILE reaches the cap. Measured on the encoded file, not on
    // the JPEGs fed in: a 1080p+ desktop is ~130KB/frame, so input bytes cross any sane cap in minutes
    // while the H.264 is an order of magnitude smaller.
    if (r.frames % CAP_CHECK_FRAMES < total
        && (sessionOverCap(this.sizeOf(r.file), this.cfg()) || fileOverAge(r.partOpenedAt, Date.now(), this.cfg()))) {
      void this.roll(id);
    }
    try {
      for (let i = 0; i < total; i++) r.proc.stdin?.write(buf);
    } catch { /* ffmpeg gone; stop() cleans up */ }
  }

  /**
   * Finalise the current part and continue into the next one. Frames arriving mid-roll are dropped for
   * the few hundred ms the swap takes — a couple of dropped frames is the right trade against either
   * buffering unboundedly or stopping the recording outright.
   */
  private async roll(id: string): Promise<void> {
    const r = this.recs.get(id);
    if (!r || r.stopped || r.rolling) return;
    r.rolling = true;
    const old = r.proc;
    const oldFile = r.file;
    const next = r.part + 1;
    try {
      await this.closeProc(old);
      const bytes = this.sizeOf(oldFile);
      r.closedBytes += bytes;
      this.log.log(`recording ${id} part ${r.part} complete (${(bytes / 1048576).toFixed(1)} MB) -> starting part ${next}`);
      const p = this.spawnPart(id, next, r.fps);
      if (!p) { r.stopped = true; this.recs.delete(id); return; }
      r.proc = p.proc;
      r.file = p.file;
      r.part = next;
      // The swap took real time; do not bill it to the new part as a gap to pad.
      r.lastWriteAt = Date.now();
      r.partOpenedAt = Date.now();
    } finally {
      r.rolling = false;
    }
  }

  /** Is this session currently writing video? (Running and not paused by the operator.) */
  isRecording(id: string): boolean {
    const r = this.recs.get(id);
    return !!r && !r.stopped && !r.paused;
  }

  /**
   * Stop writing, without ending the session. The current part is finalised properly so what has been
   * recorded so far stays playable; the viewer keeps streaming. Resuming opens the NEXT part rather
   * than reopening this one, so a gap in the recording is visible as a part boundary instead of being
   * spliced invisibly into the middle of a file.
   */
  async pause(id: string): Promise<boolean> {
    const r = this.recs.get(id);
    if (!r || r.stopped || r.paused) return false;
    r.paused = true;
    if (r.timer) { clearInterval(r.timer); r.timer = null; }
    await this.closeProc(r.proc);
    r.closedBytes += this.sizeOf(r.file);
    this.log.log(`recording ${id} paused by the operator after part ${r.part}`);
    return true;
  }

  /** Start writing again, into a new part. */
  resume(id: string): boolean {
    const r = this.recs.get(id);
    if (!r || r.stopped || !r.paused) return false;
    const next = r.part + 1;
    const p = this.spawnPart(id, next, r.fps);
    if (!p) return false;
    r.proc = p.proc;
    r.file = p.file;
    r.part = next;
    r.paused = false;
    r.pending = null;
    r.lastWriteAt = Date.now();
    r.partOpenedAt = Date.now();
    r.timer = setInterval(() => this.pump(id), Math.max(20, Math.round(1000 / r.fps)));
    this.log.log(`recording ${id} resumed into part ${next}`);
    return true;
  }

  /** Close the stream and finalise the last part. Returns every part written for this session. */
  async stop(id: string): Promise<{ files: string[]; bytes: number; frames: number; parts: number; padded: number } | null> {
    const r = this.recs.get(id);
    if (!r) return null;
    r.stopped = true;
    if (r.timer) clearInterval(r.timer);
    this.recs.delete(id);
    // A paused session already finalised its last part; closing the dead process again would just wait
    // out the 15s kill timer for nothing.
    if (!r.paused) await this.closeProc(r.proc);

    // Collect every part that actually has bytes; drop empties (ffmpeg may never have produced one).
    const files: string[] = [];
    let bytes = 0;
    for (let i = 1; i <= r.part; i++) {
      const f = partFile(id, i);
      const n = this.sizeOf(f);
      if (n > 0) { files.push(f); bytes += n; }
      else { try { fs.unlinkSync(f); } catch { /* noop */ } }
    }
    if (!files.length) return null;
    const still = r.frames ? Math.round((r.padded / r.frames) * 100) : 0;
    this.log.log(`recording ${id} finalised: ${files.length} part(s), ${(bytes / 1048576).toFixed(1)} MB, ${r.frames} frames (${still}% still)`);
    return { files, bytes, frames: r.frames, parts: files.length, padded: r.padded };
  }

  /** List what's on disk, for the retention sweep. */
  listFiles(): { path: string; bytes: number; mtime: Date }[] {
    try {
      return fs.readdirSync(RECORDINGS_DIR)
        .filter((n) => n.endsWith('.mp4'))
        .map((n) => {
          const p = path.join(RECORDINGS_DIR, n);
          const st = fs.statSync(p);
          return { path: p, bytes: st.size, mtime: st.mtime };
        });
    } catch {
      return [];
    }
  }

  remove(file: string): boolean {
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }

  /** Total bytes + file count on disk — powers the storage panel and the "clear" action. */
  usage(): { files: number; bytes: number; oldest: Date | null } {
    const f = this.listFiles();
    return {
      files: f.length,
      bytes: f.reduce((a, x) => a + x.bytes, 0),
      oldest: f.length ? f.reduce((a, x) => (x.mtime < a ? x.mtime : a), f[0].mtime) : null,
    };
  }
}
