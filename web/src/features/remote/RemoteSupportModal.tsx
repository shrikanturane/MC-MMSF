'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Badge } from '@/components/ui';
import { useDeleteRecording, useEndRemote, useRemoteSession, useRemoteStorage, useRemoteRecordings, useRequestRemote, useSetRemoteAudio, useSetRemoteInput, useSetRemoteQuality, useSetRemoteRecording, type RecordingEntry, type RemoteSession } from '@/lib/hooks';
import { apiBlob, apiBlobUrl, apiPost, authToken, mediaViewerWsUrl } from '@/lib/api';

// The remote console quality ladder, YouTube-style. Value is what the server/agent understand.
const QUALITY_OPTIONS: { v: string; label: string }[] = [
  { v: '144p', label: '144p — lowest (min)' },
  { v: '240p', label: '240p — very low' },
  { v: '360p', label: '360p — low (medium)' },
  { v: '480p', label: '480p — balanced' },
  { v: '720p', label: '720p HD — smooth (good)' },
  { v: '1080p', label: '1080p Full HD — sharpest (high)' },
];

/** Kilobits/s -> a human string. Bandwidth is what an operator judging a link thinks in. */
function fmtKbps(kbps: number): string {
  if (kbps <= 0) return '— kbps';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

const STATUS_COLOR: Record<string, string> = {
  requested: '#3b82f6',
  'awaiting-consent': '#f59e0b',
  active: '#22c55e',
  ended: '#64748b',
  declined: '#ef4444',
  expired: '#64748b',
  failed: '#ef4444',
};

/** What the operator is told. Whether the user was asked — or not — is stated plainly either way. */
function StatusLine({ s }: { s: RemoteSession }) {
  if (s.status === 'requested') return <>Contacting the agent on <b className="text-white">{s.targetName}</b>…</>;
  if (s.status === 'awaiting-consent')
    return (
      <>
        Waiting for <b className="text-white">{s.consentUser || 'the user at the console'}</b> to accept this session
        {s.consentSecondsLeft != null ? (
          s.targetIsServer
            ? <> — starts automatically in <b className="text-white">{s.consentSecondsLeft}s</b> if they don&apos;t answer (server policy)</>
            : <> — this request is <b className="text-warning">cancelled in {s.consentSecondsLeft}s</b> if not accepted (Windows 10/11 must approve)</>
        ) : null}.
      </>
    );
  if (s.status === 'declined') return <span className="text-danger">The user at the console declined this session.</span>;
  if (s.status === 'expired') return <span className="text-muted">{s.endReason || 'The agent did not respond.'}</span>;
  if (s.status === 'failed') return <span className="text-danger">{s.endReason || 'The session failed.'}</span>;
  if (s.status === 'ended') return <span className="text-muted">Session ended{s.durationSec != null ? ` after ${s.durationSec}s` : ''}{s.endReason ? ` — ${s.endReason}` : ''}.</span>;
  if (s.consent === 'auto-accepted') return <span className="text-warning">Streaming — the prompt was <b>not answered</b>; started automatically per policy.</span>;
  // Unattended mode reaches here. Name whose desktop this is even though nobody was asked — that is the
  // whole accountability story when there is no prompt.
  if (s.consent === 'not-required')
    return (
      <span className="text-warning">
        Streaming (unattended — no permission prompt){s.consentUser ? <> · signed in: <b className="text-white">{s.consentUser}</b></> : ' · no interactive user'}
      </span>
    );
  return <span className="text-success">Streaming — consent granted by <b className="text-white">{s.consentUser}</b>.</span>;
}


type WireInput =
  | { k: 'move'; x: number; y: number }
  | { k: 'down' | 'up'; b: 'l' | 'r' | 'm'; x: number; y: number }
  | { k: 'scroll'; d: number; x: number; y: number }
  | { k: 'key'; vk: number; down: boolean };

/**
 * Where in the TARGET's screen did the operator click?
 *
 * The picture is letterboxed inside its box (object-contain), so the element's own rectangle is the
 * wrong frame of reference — using it would put every click off by the size of the black bars. This maps
 * through the image's natural aspect ratio and returns null outside the picture, so a click on the
 * letterbox does nothing rather than landing somewhere arbitrary on someone's desktop.
 */
function normPoint(el: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const r = el.getBoundingClientRect();
  // The canvas backing store is the TARGET's resolution; its CSS box is whatever fits on screen.
  const nw = el.width || r.width;
  const nh = el.height || r.height;
  if (!r.width || !r.height || !nw || !nh) return null;
  const scale = Math.min(r.width / nw, r.height / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  const x = (clientX - r.left - (r.width - dw) / 2) / dw;
  const y = (clientY - r.top - (r.height - dh) / 2) / dh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

const BUTTON: Record<number, 'l' | 'r' | 'm'> = { 0: 'l', 1: 'm', 2: 'r' };

// Browser key event -> Windows virtual-key code. `keyCode` is deprecated but on Windows it already IS
// the VK for every key that matters here, and nothing has replaced it for this purpose. `code` covers
// the handful of layouts where keyCode comes back 0 or 229 (IME composition).
const VK_BY_CODE: Record<string, number> = {
  Escape: 27, Tab: 9, Enter: 13, NumpadEnter: 13, Backspace: 8, Delete: 46, Insert: 45,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
  MetaLeft: 91, MetaRight: 92, CapsLock: 20, Space: 32,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};
function vkFor(e: KeyboardEvent): number | null {
  const legacy = e.keyCode;
  if (legacy && legacy !== 229 && legacy <= 254) return legacy;
  return VK_BY_CODE[e.code] ?? null;
}

/**
 * Send the operator's keyboard and mouse to the target while control is on.
 *
 * Events are batched on a short timer rather than posted individually: a mouse drag generates dozens of
 * moves a second and one request each would arrive out of order, which shows up as a pointer that jumps
 * backwards. Batching also means the server sees the movement in the order it happened.
 */
function useRemoteInput(id: string | null, enabled: boolean, imgRef: RefObject<HTMLCanvasElement | null>) {
  const buf = useRef<WireInput[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!id || !enabled) return;
    const img = imgRef.current;
    if (!img) return;
    let stop = false;
    const push = (e: WireInput) => { if (buf.current.length < 200) buf.current.push(e); };
    const at = (ev: MouseEvent | WheelEvent) => normPoint(img, ev.clientX, ev.clientY);

    let lastMove = 0;
    const onMove = (ev: MouseEvent) => {
      const now = Date.now();
      if (now - lastMove < 40) return; // ~25/s is smooth; more is just traffic
      lastMove = now;
      const p = at(ev);
      if (p) push({ k: 'move', ...p });
    };
    const onDown = (ev: MouseEvent) => {
      const p = at(ev);
      if (!p) return;
      ev.preventDefault();
      push({ k: 'down', b: BUTTON[ev.button] ?? 'l', ...p });
    };
    const onUp = (ev: MouseEvent) => {
      const p = at(ev);
      if (!p) return;
      ev.preventDefault();
      push({ k: 'up', b: BUTTON[ev.button] ?? 'l', ...p });
    };
    const onWheel = (ev: WheelEvent) => {
      const p = at(ev);
      if (!p) return;
      ev.preventDefault();
      // A wheel notch is 120 on Windows and the browser reports downward scroll as positive; invert.
      push({ k: 'scroll', d: Math.round(-ev.deltaY), ...p });
    };
    const onCtx = (ev: MouseEvent) => { if (at(ev)) ev.preventDefault(); }; // right-click belongs to the target
    const onKey = (ev: KeyboardEvent) => {
      const vk = vkFor(ev);
      if (vk === null) return;
      // Let the operator keep Escape for leaving full screen — otherwise there is no way out of a
      // fullscreen session that has swallowed the keyboard.
      if (ev.key === 'Escape') return;
      ev.preventDefault();
      push({ k: 'key', vk, down: ev.type === 'keydown' });
    };

    img.addEventListener('mousemove', onMove);
    img.addEventListener('mousedown', onDown);
    img.addEventListener('mouseup', onUp);
    img.addEventListener('wheel', onWheel, { passive: false });
    img.addEventListener('contextmenu', onCtx);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    const flush = async () => {
      if (stop || !buf.current.length) return;
      const events = buf.current;
      buf.current = [];
      try {
        await apiPost(`/remote/sessions/${id}/input`, { events });
        setErr('');
      } catch (e) {
        setErr(String((e as Error).message));
      }
    };
    const t = setInterval(() => void flush(), 60);

    return () => {
      stop = true;
      clearInterval(t);
      img.removeEventListener('mousemove', onMove);
      img.removeEventListener('mousedown', onDown);
      img.removeEventListener('mouseup', onUp);
      img.removeEventListener('wheel', onWheel);
      img.removeEventListener('contextmenu', onCtx);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      buf.current = [];
    };
  }, [id, enabled, imgRef]);

  return err;
}


const fmtMb = (n: number) => (n / 1048576).toFixed(1);
const fmtDur = (s: number | null) => {
  if (!s) return '—';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
};

/**
 * Watch a recorded session back. The video is fetched WITH auth and played from a blob: the endpoint
 * is admin-guarded, and a plain <video src> sends no Authorization header, so it would simply 401.
 */
function RecordingPlayer({ id, part, onClose }: { id: string; part: number; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let dead = false;
    let made: string | null = null;
    apiBlobUrl(`/remote/sessions/${id}/recording.mp4?part=${part}`)
      .then((u) => {
        if (dead) { URL.revokeObjectURL(u); return; }
        made = u;
        setUrl(u);
      })
      .catch((e) => !dead && setErr(String((e as Error).message)));
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [id, part]);
  const download = async () => {
    try {
      const u = await apiBlobUrl(`/remote/sessions/${id}/recording.mp4?part=${part}&download=1`);
      const a = document.createElement('a');
      a.href = u;
      a.download = `remote-${id}-part${part}.mp4`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 30_000);
    } catch (e) { setErr(String((e as Error).message)); }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-4xl rounded-xl border border-border bg-card p-3" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2 text-2xs text-muted">
          <span>Recording · part {part}</span>
          <button onClick={download} className="ml-auto rounded-md border border-border bg-bg px-2 py-1 text-muted-light hover:text-white">⬇ Download</button>
          <button onClick={onClose} className="rounded-md border border-border bg-bg px-2 py-1 text-muted-light hover:text-white">Close</button>
        </div>
        {err ? (
          <div className="space-y-2">
            <div className="rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">Could not play this recording in the browser: {err}</div>
            <button onClick={download} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft">⬇ Download the video instead</button>
          </div>
        ) : !url ? (
          <div className="p-8 text-center text-2xs text-muted">Loading the video…</div>
        ) : (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={url}
            controls
            autoPlay
            onError={() => setErr('the browser could not decode this file')}
            className="max-h-[75vh] w-full rounded bg-black"
          />
        )}
      </div>
    </div>
  );
}

/** The recording library: past sessions, newest first, with a play button per part. */
function RecordingsPanel() {
  const { data } = useRemoteRecordings();
  const { data: storage } = useRemoteStorage();
  const del = useDeleteRecording();
  const [playing, setPlaying] = useState<{ id: string; part: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (!data) return null;
  const withVideo = data.filter((r) => !r.expired);
  const downloadPart = async (id: string, part: number, target: string) => {
    try {
      const u = await apiBlobUrl(`/remote/sessions/${id}/recording.mp4?part=${part}&download=1`);
      const a = document.createElement('a');
      a.href = u;
      a.download = `remote-${target}-${id}-part${part}.mp4`.replace(/[^\w.-]/g, '_');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 30_000);
    } catch { /* the browser surfaces the failed download itself */ }
  };
  return (
    <div className="rounded-lg border border-border bg-bg/50 p-3 text-2xs text-muted">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left">
        <span>
          ▶ Recorded sessions: <b className="text-white">{withVideo.length}</b>
          {data.length > withVideo.length ? <> · {data.length - withVideo.length} aged out</> : null}
          {storage ? <> · <b className="text-white">{storage.mb} MB</b> on disk</> : null}
        </span>
        <span className="ml-auto text-muted-light">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-border">
          {!withVideo.length ? (
            <div className="p-4 text-center">No recordings are on disk. They are kept 15 days.</div>
          ) : (
            <table className="w-full">
              <thead className="sticky top-0 bg-card text-muted">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">When</th>
                  <th className="px-2 py-1 text-left font-medium">Computer</th>
                  <th className="px-2 py-1 text-left font-medium">Operator</th>
                  <th className="px-2 py-1 text-right font-medium">Length</th>
                  <th className="px-2 py-1 text-right font-medium">Size</th>
                  <th className="px-2 py-1 text-left font-medium">Watch / download</th>
                </tr>
              </thead>
              <tbody>
                {withVideo.map((r: RecordingEntry) => (
                  <tr key={r.id} className="border-t border-border/60 align-top">
                    <td className="px-2 py-1 text-white">{new Date(r.startedAt).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="px-2 py-1 text-white">{r.targetName}</td>
                    <td className="px-2 py-1">{r.operatorEmail || '—'}</td>
                    <td className="px-2 py-1 text-right">{fmtDur(r.durationSec)}</td>
                    <td className="px-2 py-1 text-right">{fmtMb(r.bytes)} MB</td>
                    <td className="px-2 py-1">
                      <span className="flex flex-wrap items-center gap-1">
                        {r.parts.filter((p) => !p.missing).map((p) => (
                          <span key={p.part} className="inline-flex overflow-hidden rounded border border-border">
                            <button
                              onClick={() => setPlaying({ id: r.id, part: p.part })}
                              title={`Play part ${p.part} (${fmtMb(p.bytes)} MB)`}
                              className="bg-bg px-1.5 py-0.5 text-muted-light hover:text-white"
                            >
                              ▶ {r.parts.length > 1 ? `p${p.part}` : 'play'}
                            </button>
                            <button
                              onClick={() => downloadPart(r.id, p.part, r.targetName)}
                              title={`Download part ${p.part} (${fmtMb(p.bytes)} MB)`}
                              className="border-l border-border bg-bg px-1.5 py-0.5 text-muted-light hover:text-white"
                            >
                              ⬇
                            </button>
                          </span>
                        ))}
                        {confirmId === r.id ? (
                          <span className="inline-flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-1 py-0.5 text-danger">
                            Delete?
                            <button onClick={() => del.mutate(r.id, { onSettled: () => setConfirmId(null) })} className="rounded bg-danger/20 px-1">{del.isPending ? '◌' : 'Yes'}</button>
                            <button onClick={() => setConfirmId(null)} className="rounded border border-border px-1 text-muted-light">No</button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmId(r.id)}
                            title="Clear this session's recording from disk"
                            className="rounded border border-border bg-bg px-1.5 py-0.5 text-muted-light hover:text-danger"
                          >
                            🗑
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {playing && <RecordingPlayer id={playing.id} part={playing.part} onClose={() => setPlaying(null)} />}
    </div>
  );
}

/**
 * Remote support viewer. Renders the target's PRIMARY monitor (its real console, unlike RDP which opens
 * a separate session). Frames only exist while the server holds the session active, so an ended or
 * declined session simply has nothing to show.
 */
/** The "My Computer" sentinel the agent expands to the list of drive roots. */
const DRIVES = '::drives';
/** Is this an absolute Windows path already (a drive root like "C:\" or any "X:\…")? */
function isAbsWin(name: string): boolean {
  return /^[A-Za-z]:[\\/]?/.test(name) || name.startsWith('\\\\'); // drive-qualified or UNC share
}
/**
 * Join a remote folder path and a child name. Two special cases keep drive navigation sane:
 *  - from the "My Computer" view (or when the child is itself a drive root / absolute path), the child
 *    IS the destination — never glue it onto the sentinel (that produced the broken "::drives\C:\").
 */
function joinWinPath(dir: string, name: string): string {
  if (!dir || dir === DRIVES || isAbsWin(name)) return name;
  const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sep + name;
}
/** The parent of a remote path. A drive root ("C:\") goes up to My Computer; the sentinel stays put. */
function parentWinPath(p: string): string {
  if (!p || p === DRIVES) return DRIVES;
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return DRIVES; // at a drive root -> back to the drive list
  const norm = p.replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  if (idx < 0) return DRIVES;
  if (/^[A-Za-z]:$/.test(norm.slice(0, idx))) return norm.slice(0, idx + 1); // parent is a drive root, keep the slash
  return norm.slice(0, idx + 1);
}
/** A friendly label for the breadcrumb: the sentinel reads as "This PC". */
function pathLabel(p: string): string {
  return !p ? 'This PC' : p === DRIVES ? 'This PC' : p;
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
/** SHA-256 of a buffer as lowercase hex — the integrity checksum for every file transfer (both ways).
 *  (The browser's Web Crypto can't do MD5; SHA-256 is stronger and serves the same verify-on-arrival job.) */
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Two-way audio over the media socket, active only while `audioOn` (the server's audioEnabled flag).
 *
 * PLAY: incoming 'A' frames ([srcTag][pcm16 mono 48k]) are scheduled back-to-back on a per-source
 * playhead so the target's system audio and its microphone mix naturally at the speakers, with a small
 * jitter buffer. TALK: the operator's mic is captured, resampled to 48 kHz mono int16 and sent as 'D'
 * frames — suppressed while `micMutedRef` is true, so the operator can listen without talking. Denying
 * the mic prompt is not fatal: listening still works. Everything is torn down the instant audio is off.
 */
function useRemoteAudio(
  audioOn: boolean,
  micMutedRef: RefObject<boolean>,
  mediaWsRef: RefObject<WebSocket | null>,
  downlinkRef: RefObject<((pcm: Uint8Array) => void) | null>,
) {
  useEffect(() => {
    if (!audioOn) return;
    let stop = false;
    let ctx: AudioContext | null = null;
    let micStream: MediaStream | null = null;
    let proc: ScriptProcessorNode | null = null;
    let srcNode: MediaStreamAudioSourceNode | null = null;
    const playHeads: Record<number, number> = {};

    const setup = async () => {
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      try { ctx = new Ctor({ sampleRate: 48000 }); } catch { ctx = new Ctor(); }
      try { await ctx.resume(); } catch { /* autoplay: resumes on the next gesture */ }
      const rate = ctx.sampleRate;

      // PLAY incoming remote audio.
      downlinkRef.current = (payload: Uint8Array) => {
        if (stop || !ctx) return;
        const src = payload[0];
        const n = (payload.length - 1) >> 1;
        if (n <= 0) return;
        const f32 = new Float32Array(n);
        const dv = new DataView(payload.buffer, payload.byteOffset + 1, n * 2);
        for (let i = 0; i < n; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;
        const buf = ctx.createBuffer(1, n, 48000); // AudioBufferSource resamples 48k -> context rate
        buf.copyToChannel(f32, 0);
        const node = ctx.createBufferSource();
        node.buffer = buf; node.connect(ctx.destination);
        const now = ctx.currentTime;
        let head = playHeads[src] ?? 0;
        if (head < now + 0.08) head = now + 0.08; // ~80ms jitter buffer; resync if we fell behind
        node.start(head);
        playHeads[src] = head + buf.duration;
      };

      // TALK: capture the operator's mic. Best-effort — listening still works if denied.
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (stop || !ctx) { micStream.getTracks().forEach((t) => t.stop()); return; }
        srcNode = ctx.createMediaStreamSource(micStream);
        proc = ctx.createScriptProcessor(2048, 1, 1);
        srcNode.connect(proc);
        proc.connect(ctx.destination); // some browsers only fire onaudioprocess when connected
        proc.onaudioprocess = (ev) => {
          if (stop || micMutedRef.current) return;
          const ws = mediaWsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          const input = ev.inputBuffer.getChannelData(0); // Float32 @ context rate
          const outLen = Math.max(1, Math.round((input.length * 48000) / rate));
          const frame = new Uint8Array(1 + outLen * 2);
          frame[0] = 0x44; // 'D'
          const out = new DataView(frame.buffer);
          for (let i = 0; i < outLen; i++) {
            const sp = (i * rate) / 48000;
            const i0 = Math.floor(sp); const fr = sp - i0;
            const s = (input[i0] ?? 0) * (1 - fr) + (input[i0 + 1] ?? 0) * fr;
            out.setInt16(1 + i * 2, (Math.max(-1, Math.min(1, s)) * 32767) | 0, true);
          }
          ws.send(frame);
        };
      } catch { /* mic denied — listen-only */ }
    };
    void setup();

    return () => {
      stop = true;
      downlinkRef.current = null;
      try { proc?.disconnect(); } catch { /* */ }
      try { srcNode?.disconnect(); } catch { /* */ }
      try { micStream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
      try { ctx?.close(); } catch { /* */ }
    };
  }, [audioOn, micMutedRef, mediaWsRef, downlinkRef]);
}

export function RemoteSupportModal({ agentId, targetName, onClose }: { agentId: string; targetName: string; onClose: () => void }) {
  const [reason, setReason] = useState('Support');
  const [startQuality, setStartQuality] = useState<string>('480p');
  const [id, setId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [full, setFull] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const req = useRequestRemote();
  const end = useEndRemote();
  const setInput = useSetRemoteInput();
  const setRec = useSetRemoteRecording();
  const setQuality = useSetRemoteQuality();
  const setAudio = useSetRemoteAudio();
  const { data: s } = useRemoteSession(id);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Bumped by the watchdog to restart the frame loop after a stall. */
  const [stallCount, setStallCount] = useState(0);
  /** The persistent media socket (Phase 1 video, Phase 2 audio). Kept in a ref so the audio panel can
   *  send admin mic frames down the same socket without re-opening it. */
  const mediaWsRef = useRef<WebSocket | null>(null);
  /** When the socket last painted a frame — the HTTP poll below stands down while this is fresh. */
  const wsLastFrameRef = useRef(0);
  /** Set by the audio panel (Phase 2) to receive incoming remote-audio PCM; null while audio is off. */
  const audioDownlinkRef = useRef<((pcm: Uint8Array) => void) | null>(null);
  /** Text control messages (chat / fs.list / file.end) and file-download binary chunks from the socket. */
  const ctrlRef = useRef<((msg: any) => void) | null>(null);
  const fileBinRef = useRef<((buf: Uint8Array) => void) | null>(null);
  /** Set when the server refuses the socket (e.g. the 6-viewer cap) so we stop reconnecting. */
  const wsRefusedRef = useRef(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // The server's flag is the truth, not the checkbox: control can be revoked server-side, and the box
  // must follow that rather than claim the operator still has the keyboard.
  const inputOn = s?.status === 'active' && s?.inputEnabled === true;
  const recOn = s?.status === 'active' && s?.recording !== false;
  const inputErr = useRemoteInput(id, inputOn, canvasRef);
  // Two-way audio follows the server flag, same as input. Mic-mute lets the operator listen without
  // talking; it is read live inside the capture callback via a ref so toggling it needs no re-setup.
  const audioOn = s?.status === 'active' && s?.audioEnabled === true;
  // The operator's microphone starts MUTED: audio from the remote machine (its speakers + the person's
  // mic) plays live the moment audio is on, but nothing leaves the operator's mic until they choose to
  // talk. So enabling audio is "listen only" by default; unmute to speak to the person at the console.
  const [micMuted, setMicMuted] = useState(true);
  /** Live downlink (admin→PC) stats reported by the agent: recv = mic samples that arrived, played =
   *  samples the remote speaker accepted. Lets us tell "your mic isn't sending" from "device won't play". */
  const [audioStat, setAudioStat] = useState<{ recv: number; played: number; peak: number; info: string; err: string } | null>(null);
  const micMutedRef = useRef(true);
  useEffect(() => { micMutedRef.current = micMuted; }, [micMuted]);
  useRemoteAudio(audioOn, micMutedRef, mediaWsRef, audioDownlinkRef);

  // ── Chat + file transfer, both over the media socket (wss — no plaintext path) ──
  const [panel, setPanel] = useState<'none' | 'comm'>('none');
  const [showFiles, setShowFiles] = useState(true);
  const [chatLog, setChatLog] = useState<{ from: string; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLInputElement | null>(null);
  const attachCfgRef = useRef<{ mode: 'offer' | 'ask' | 'direct' }>({ mode: 'offer' });
  const [fsPath, setFsPath] = useState('');
  const [fsEntries, setFsEntries] = useState<{ name: string; dir: boolean; size: number }[]>([]);
  const [fsErr, setFsErr] = useState('');
  const [xfer, setXfer] = useState('');
  const dlRef = useRef<{ chunks: BlobPart[]; name: string; bytes: number } | null>(null);
  const reqIdRef = useRef(1);
  /** Upload handshake: reqId → resolver, fired when the agent replies 'file.dest' with the final path
   *  (or that the person cancelled). Lets us stream bytes only once the destination is fixed. */
  const destWaitersRef = useRef<Record<number, (m: any) => void>>({});
  /** reqId → SHA-256 of what we sent, so the 'file.end' reply can be verified against it. */
  const uploadHashRef = useRef<Record<number, string>>({});
  /** offerId → what the operator offered in chat (a file or a whole folder); streamed only when the
   *  remote user clicks Download and picks a destination. */
  const offersRef = useRef<Record<string, { file?: File; files?: File[]; isFolder: boolean }>>({});
  const folderRef = useRef<HTMLInputElement | null>(null);
  const wsSend = useCallback((obj: any) => { const ws = mediaWsRef.current; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }, []);

  /**
   * Stream a file's bytes to the agent as 'F' frames for an already-opened destination (reqId), with a
   * SHA-256 to verify on arrival and a progress read-out. Large files go as many 60 KB parts kept in
   * flight (multipart), throttled by socket backpressure so memory stays bounded. Ends with file.end.
   */
  const streamFile = useCallback(async (file: File, rid: number, path: string) => {
    const ws = mediaWsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) { setXfer('Not connected.'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    uploadHashRef.current[rid] = await sha256Hex(bytes.buffer);
    const total = bytes.length; const CH = 60 * 1024; let seq = 0;
    setXfer(`Sending ${file.name} → ${path} … 0%`);
    for (let off = 0; off < total; off += CH) {
      const slice = bytes.subarray(off, off + CH);
      const frame = new Uint8Array(7 + slice.length);
      const dv = new DataView(frame.buffer);
      frame[0] = 0x46; dv.setUint16(1, rid & 0xffff, true); dv.setUint32(3, seq++, true);
      frame.set(slice, 7);
      ws.send(frame);
      // Multipart backpressure: keep ~8 MB of parts in flight, then wait for the socket to drain.
      while (ws.bufferedAmount > 8 * 1024 * 1024) await new Promise((r) => setTimeout(r, 15));
      if (seq % 16 === 0 || off + CH >= total) setXfer(`Sending ${file.name}: ${Math.min(100, Math.round(((off + CH) / total) * 100))}%`);
    }
    wsSend({ t: 'file.end', reqId: rid });
  }, [wsSend]);
  const newOfferId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `o${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  /** Offer a file in chat — the remote user gets a Download button and picks where to save it. */
  const offerFile = useCallback((file: File) => {
    const ws = mediaWsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) { setXfer('Not connected.'); return; }
    const offerId = newOfferId();
    offersRef.current[offerId] = { file, isFolder: false };
    wsSend({ t: 'chat.file', offerId, name: file.name, size: file.size });
    setChatLog((p) => [...p, { from: 'operator', text: `📎 Offered: ${file.name} (${fmtSize(file.size)}) — waiting for them to Download` }].slice(-200));
  }, [wsSend]);
  /** Offer a whole folder — the remote user picks a destination and the subtree is recreated there. */
  const offerFolder = useCallback((files: File[]) => {
    const ws = mediaWsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) { setXfer('Not connected.'); return; }
    if (!files.length) return;
    const offerId = newOfferId();
    const total = files.reduce((a, f) => a + f.size, 0);
    const folderName = (files[0].webkitRelativePath || files[0].name).split('/')[0] || 'folder';
    offersRef.current[offerId] = { files, isFolder: true };
    wsSend({ t: 'chat.file', offerId, name: folderName, size: total, kind: 'folder', count: files.length });
    setChatLog((p) => [...p, { from: 'operator', text: `📁 Offered folder: ${folderName} (${files.length} files, ${fmtSize(total)}) — waiting for them to Download` }].slice(-200));
  }, [wsSend]);
  /** Stream every file of a folder to `destParent`, recreating the subtree from each webkitRelativePath. */
  const streamFolder = useCallback(async (files: File[], destParent: string) => {
    const base = destParent.replace(/[\\/]+$/, '');
    let done = 0;
    for (const f of files) {
      const rel = (f.webkitRelativePath || f.name).replace(/\//g, '\\');
      const abs = `${base}\\${rel}`;
      const rid = reqIdRef.current++;
      const dest: any = await new Promise((res) => {
        destWaitersRef.current[rid] = res;
        wsSend({ t: 'file.put', reqId: rid, path: abs, size: f.size });
        setTimeout(() => { if (destWaitersRef.current[rid]) { delete destWaitersRef.current[rid]; res({ cancelled: true }); } }, 180_000);
      });
      if (!dest || dest.cancelled) continue;
      await streamFile(f, rid, dest.path);
      done += 1;
      setXfer(`Sending folder: ${done}/${files.length} files…`);
    }
    setXfer(`Folder sent: ${done}/${files.length} files → ${base}`);
  }, [wsSend, streamFile]);
  const streamFileRef = useRef(streamFile);
  useEffect(() => { streamFileRef.current = streamFile; }, [streamFile]);
  const streamFolderRef = useRef(streamFolder);
  useEffect(() => { streamFolderRef.current = streamFolder; }, [streamFolder]);
  // The folder <input> needs the non-standard webkitdirectory attribute; set it via ref to avoid TS/JSX friction.
  useEffect(() => { if (folderRef.current) { folderRef.current.setAttribute('webkitdirectory', ''); folderRef.current.setAttribute('directory', ''); } }, []);

  useEffect(() => {
    ctrlRef.current = async (msg: any) => {
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'chat') setChatLog((p) => [...p, { from: msg.from || 'user', text: String(msg.text || '') }].slice(-200));
      else if (msg.t === 'fs.list') {
        if (msg.error) {
          // Robustness against agent quirks: a pre-1.14 agent errors on the '::drives' sentinel, and an
          // agent that can't resolve the signed-in user's Desktop errors on the empty path. In BOTH cases
          // fall back to '::drives' → '' (the drive list) so the operator sees folders instead of an error.
          if (msg.path === '::drives') { setFsErr(''); wsSend({ t: 'fs.list', reqId: reqIdRef.current++, path: '' }); return; }
          if (msg.path === '' || msg.path == null) { setFsErr(''); wsSend({ t: 'fs.list', reqId: reqIdRef.current++, path: '::drives' }); return; }
          setFsErr(String(msg.error));
        } else { setFsErr(''); setFsPath(msg.path || ''); setFsEntries(Array.isArray(msg.entries) ? msg.entries : []); }
      }
      else if (msg.t === 'error') { setErr(String(msg.message || 'Remote session error')); wsRefusedRef.current = true; try { mediaWsRef.current?.close(); } catch { /* */ } }
      else if (msg.t === 'audio.stat') { setAudioStat({ recv: Number(msg.recv) || 0, played: Number(msg.played) || 0, peak: Number(msg.peak) || 0, info: String(msg.info || ''), err: String(msg.err || '') }); }
      else if (msg.t === 'file.dest') { const w = destWaitersRef.current[msg.reqId]; if (w) { delete destWaitersRef.current[msg.reqId]; w(msg); } }
      else if (msg.t === 'file.pull') {
        // The person at the remote PC clicked Download on an offered file and chose where to save it —
        // NOW we send the bytes (multipart) to the path they picked.
        const off = offersRef.current[msg.offerId];
        if (!off) { setXfer('That offered item is no longer available.'); return; }
        delete offersRef.current[msg.offerId];
        if (off.isFolder && off.files) void streamFolderRef.current(off.files, String(msg.path || ''));
        else if (off.file) void streamFileRef.current(off.file, Number(msg.reqId) || reqIdRef.current++, String(msg.path || off.file.name));
      }
      else if (msg.t === 'file.end') {
        if (msg.dir === 'down') {
          const d = dlRef.current;
          if (d && msg.ok !== false) {
            const blob = new Blob(d.chunks);
            // Verify integrity: recompute SHA-256 over what arrived and compare to the agent's.
            let tag = '';
            if (msg.sha256) {
              try { const got = await sha256Hex(await blob.arrayBuffer()); tag = got.toLowerCase() === String(msg.sha256).toLowerCase() ? ' · ✓ integrity verified' : ' · ✗ CHECKSUM MISMATCH — do not trust this file'; } catch { /* */ }
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = d.name; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            setXfer(`Downloaded ${d.name} (${d.bytes.toLocaleString()} bytes)${tag}`);
          } else setXfer(`Download failed: ${msg.error || 'unknown error'}`);
          dlRef.current = null;
        } else {
          const exp = uploadHashRef.current[msg.reqId]; delete uploadHashRef.current[msg.reqId];
          let tag = '';
          if (exp && msg.sha256) tag = exp.toLowerCase() === String(msg.sha256).toLowerCase() ? ' · ✓ integrity verified' : ' · ✗ CHECKSUM MISMATCH';
          setXfer(msg.ok !== false ? `Sent to ${msg.path} (${Number(msg.bytes || 0).toLocaleString()} bytes)${tag}` : `Upload failed: ${msg.error || ''}`);
        }
      }
    };
    fileBinRef.current = (buf: Uint8Array) => { if (!dlRef.current || buf.length < 7) return; dlRef.current.chunks.push(buf.slice(7)); dlRef.current.bytes += buf.length - 7; };
    return () => { ctrlRef.current = null; fileBinRef.current = null; };
  }, []);

  const sendChat = () => { const t = chatInput.trim(); if (!t) return; wsSend({ t: 'chat', text: t }); setChatLog((p) => [...p, { from: 'operator', text: t }].slice(-200)); setChatInput(''); };
  const browse = (path: string) => { setFsErr(''); wsSend({ t: 'fs.list', reqId: reqIdRef.current++, path }); };
  const download = (name: string) => { dlRef.current = { chunks: [], name, bytes: 0 }; setXfer(`Downloading ${name}…`); wsSend({ t: 'file.get', reqId: reqIdRef.current++, path: joinWinPath(fsPath, name) }); };
  /**
   * Send a file to the remote PC. `interactive` = the person there picks the save location via a dialog on
   * their own screen; otherwise it's stored directly into the folder the operator has open. Either way we
   * (1) wait for the agent to confirm the destination, (2) stream the bytes over wss, (3) verify SHA-256.
   */
  const upload = async (file: File, interactive = false) => {
    const ws = mediaWsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) { setXfer('Not connected.'); return; }
    if (!interactive && (!fsPath || fsPath === DRIVES)) { setXfer('Open a drive or folder first, then send the file there.'); return; }
    const rid = reqIdRef.current++;
    setXfer(`Preparing ${file.name}…`);
    setChatLog((p) => [...p, { from: 'operator', text: `📎 Sending file: ${file.name} (${fmtSize(file.size)})${interactive ? ' — asking them where to save' : ''}` }].slice(-200));
    // Ask the agent to open the destination first (interactive → dialog on the remote screen).
    const dest: any = await new Promise((res) => {
      destWaitersRef.current[rid] = res;
      wsSend({ t: 'file.put', reqId: rid, path: interactive ? file.name : joinWinPath(fsPath, file.name), size: file.size, interactive });
      setTimeout(() => { if (destWaitersRef.current[rid]) { delete destWaitersRef.current[rid]; res({ cancelled: true, timeout: true }); } }, 180_000);
    });
    if (!dest || dest.cancelled) { setXfer(interactive ? 'The person at the computer cancelled the transfer.' : `Could not save: ${dest?.error || 'no destination'}`); return; }
    await streamFile(file, rid, dest.path);
  };
  /** WhatsApp-style attach. `mode`: 'offer' = show a Download button in their chat (they choose where to
   *  save, transfer starts on their click); 'ask' = push now, dialog on their screen; 'direct' = straight
   *  into the folder the operator has open. */
  const pickAttach = (accept: string, mode: 'offer' | 'ask' | 'direct') => {
    attachCfgRef.current = { mode };
    setAttachOpen(false);
    const el = attachRef.current;
    if (!el) return;
    el.accept = accept;
    el.value = '';
    el.click();
  };

  // Pull frames only while the session is genuinely active.
  //
  // Three things here are deliberate, and each replaces something that broke in the field:
  //
  //  1. ONE REQUEST AT A TIME. This was a setInterval firing an async fetch every 100ms without waiting
  //     for the previous one. Requests overlapped and could resolve out of order.
  //  2. NO OBJECT URLs. The old code assigned a blob URL to <img> and revoked the previous one straight
  //     away. With overlapping ticks an earlier-but-later-resolving request would revoke the URL that
  //     was currently on screen, and the picture froze on the last frame that had managed to decode.
  //     Full screen made it far worse, because bigger frames take longer and overlap more -- hence
  //     "it sticks in full screen, and minimising and restoring fixes it". Decoding to an ImageBitmap
  //     and painting to a canvas has no URL lifecycle to get wrong.
  //  3. A WATCHDOG. If nothing has painted for 5s the loop is torn down and started again, so any
  //     future stall recovers on its own instead of needing the window poked.
  // Persistent media socket — the fast path. The old JPEG-per-POST poll (below) stays as an automatic
  // fallback for when the socket can't open. The agent pushes frames over one kept-open connection, so
  // the per-frame ~105ms TLS/connection cost that capped the frame rate is gone. Auth is the FIRST
  // message (a JWT in the body, never the URL). Painting is identical to the poll path: decode to an
  // ImageBitmap off the main thread and draw once.
  useEffect(() => {
    if (!id || s?.status !== 'active') return;
    let stop = false;
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (stop) return;
      try {
        ws = new WebSocket(mediaViewerWsUrl(id));
        ws.binaryType = 'arraybuffer';
        mediaWsRef.current = ws;
        ws.onopen = () => { try { ws?.send(JSON.stringify({ t: 'auth', token: authToken() })); } catch { /* */ } };
        ws.onmessage = async (ev) => {
          if (typeof ev.data === 'string') { try { ctrlRef.current?.(JSON.parse(ev.data)); } catch { /* */ } return; } // chat / fs.list / file.end
          const buf = new Uint8Array(ev.data as ArrayBuffer);
          if (!buf.length) return;
          const tag = buf[0];
          if (tag === 0x56) { // 'V' video: [tag][w u16le][h u16le][skipped u16le][jpeg...]
            if (buf.length < 8) return;
            try {
              const bmp = await createImageBitmap(new Blob([buf.subarray(7)], { type: 'image/jpeg' }));
              const canvas = canvasRef.current;
              if (stop || !canvas) { bmp.close(); return; }
              if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
              canvas.getContext('2d')?.drawImage(bmp, 0, 0);
              bmp.close();
              wsLastFrameRef.current = Date.now();
            } catch { /* a dropped frame is not fatal */ }
          } else if (tag === 0x41) { // 'A' remote audio (Phase 2) — handed to the audio panel if listening
            audioDownlinkRef.current?.(buf.subarray(1));
          } else if (tag === 0x46) { // 'F' file-download chunk: [tag][reqId u16][seq u32][data]
            fileBinRef.current?.(buf);
          }
        };
        ws.onclose = () => { mediaWsRef.current = null; if (!stop && !wsRefusedRef.current) reconnect = setTimeout(connect, 1500); };
        ws.onerror = () => { try { ws?.close(); } catch { /* */ } };
      } catch { if (!stop) reconnect = setTimeout(connect, 1500); }
    };
    connect();

    return () => { stop = true; if (reconnect) clearTimeout(reconnect); try { ws?.close(); } catch { /* */ } mediaWsRef.current = null; };
  }, [id, s?.status]);

  useEffect(() => {
    if (!id || s?.status !== 'active') return;
    let stop = false;
    let lastPaint = Date.now();

    const paint = async () => {
      const blob = await apiBlob(`/remote/sessions/${id}/frame.jpg?t=${Date.now()}`);
      const canvas = canvasRef.current;
      if (stop || !canvas) return;
      // createImageBitmap decodes off the main thread; the bitmap is closed straight after drawing so
      // nothing accumulates at frame rate.
      const bmp = await createImageBitmap(blob);
      if (stop) { bmp.close(); return; }
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      canvas.getContext('2d')?.drawImage(bmp, 0, 0);
      bmp.close();
      lastPaint = Date.now();
    };

    // Self-scheduling: the next fetch starts only once this one has finished painting.
    const loop = async () => {
      while (!stop) {
        const started = Date.now();
        // The media socket is delivering frames — stand down to a pure fallback. Keep lastPaint fresh so
        // the watchdog does not bounce this idle loop while the socket paints the canvas.
        if (Date.now() - wsLastFrameRef.current < 1500) {
          lastPaint = Date.now();
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        try {
          await paint();
        } catch {
          /* a dropped frame is not fatal - pause briefly so a failing endpoint is not hammered */
          await new Promise((r) => setTimeout(r, 250));
        }
        const spent = Date.now() - started;
        if (spent < 100) await new Promise((r) => setTimeout(r, 100 - spent));
      }
    };
    void loop();

    const watchdog = setInterval(() => {
      if (Date.now() - lastPaint > 5000) {
        // Nothing has painted for 5s. Bounce the loop rather than sit on a frozen picture.
        stop = true;
        setStallCount((n) => n + 1);
      }
    }, 1000);

    return () => {
      stop = true;
      clearInterval(watchdog);
    };
    // stallCount is in the deps on purpose: bumping it is how the watchdog restarts this effect.
  }, [id, s?.status, stallCount]);

  // Real browser fullscreen, so the remote console fills the physical display rather than a modal box.
  const toggleFull = useCallback(async () => {
    const el = shellRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) await el.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      /* fullscreen can be refused (permissions/iframe) — fall back to the in-page maximised layout */
      setFull((f) => !f);
    }
  }, []);

  // Keep our state in step with the browser's own fullscreen (Esc exits without telling us otherwise).
  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Go fullscreen automatically the moment the screen actually starts streaming.
  const wasActive = useRef(false);
  useEffect(() => {
    if (s?.status === 'active' && !wasActive.current && !minimized) {
      wasActive.current = true;
      void toggleFull();
    }
  }, [s?.status, toggleFull, minimized]);

  // A non-admin operator must pass 2FA on connect; the server signals it with { twoFactorRequired }.
  const [twoFA, setTwoFA] = useState<{ required: boolean; msg: string }>({ required: false, msg: '' });
  const [twoFACode, setTwoFACode] = useState('');
  const start = (code?: string) => {
    setErr('');
    req.mutate(
      { agentId, reason: reason.trim(), quality: startQuality, twoFactorCode: code },
      {
        onSuccess: (r: any) => {
          if (r?.twoFactorRequired) { setTwoFA({ required: true, msg: r.message || 'Enter your 6-digit code to connect.' }); return; }
          setTwoFA({ required: false, msg: '' });
          setId((r as RemoteSession).id);
        },
        onError: (e) => setErr(String((e as Error).message)),
      },
    );
  };
  const stop = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (id) end.mutate(id);
    onClose();
  };

  // The recording is written on the SERVER; this pulls it down to wherever the operator is sitting so it
  // can be saved to their own desktop. Only offered once the session has finished and produced bytes.
  const parts = s?.recordingParts ?? 0;
  const recordingReady = !!s && s.status !== 'active' && (s.recordingBytes ?? 0) > 0;
  const [dlErr, setDlErr] = useState('');
  const downloadRecording = async () => {
    if (!id) return;
    setDlErr('');
    try {
      // Fetched with auth (a bare href would 401), then handed to the browser's download UI so the
      // operator can save it wherever they like — desktop included — on the machine they are sitting at.
      // A long session is segmented into fixed-size parts, so save each one. They are separate
      // playable files rather than one huge download.
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const n = Math.max(1, parts);
      for (let i = 1; i <= n; i++) {
        const url = await apiBlobUrl(`/remote/sessions/${id}/recording.mp4?part=${i}`);
        const a = document.createElement('a');
        a.href = url;
        a.download = n > 1
          ? `remote-${targetName}-${stamp}-part${i}of${n}.mp4`
          : `remote-${targetName}-${stamp}.mp4`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        if (i < n) await new Promise((r) => setTimeout(r, 400)); // browsers throttle rapid downloads
      }
    } catch (e) {
      setDlErr(String((e as Error).message));
    }
  };
  const mb = (n?: number | null) => (n ? (n / 1048576).toFixed(1) : '0');

  // Minimized: collapse to a small floating bar. The media socket + session stay live (their effects key
  // on id/status, not on this), so frames keep flowing server-side; click Restore to bring the window back.
  if (minimized) {
    return (
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-xl">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[s?.status ?? ''] ?? '#64748b' }} />
        <span className="text-2xs text-white">🖥 {targetName}{s?.frames ? <span className="text-muted"> · {s.frames} frames</span> : null}</span>
        <button onClick={() => setMinimized(false)} title="Restore the remote window" className="rounded border border-border bg-bg px-2 py-1 text-2xs text-muted-light hover:text-white">▢ Restore</button>
        <button onClick={stop} title={s?.status === 'active' ? 'End session' : 'Close'} className="rounded border border-border bg-bg px-2 py-1 text-2xs text-muted-light hover:text-danger">✕</button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={full ? undefined : onClose}>
      <div
        ref={shellRef}
        className={`flex flex-col overflow-hidden ${full ? 'h-screen w-screen rounded-none' : 'max-h-[92vh] w-full max-w-5xl rounded-xl'} border border-border bg-card p-4`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Titlebar: name + status on the left, window controls (icons) pinned top-right like a real window. */}
        <div className="mb-2 flex shrink-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold text-white">Remote support — {targetName}</h3>
          {s && <Badge color={STATUS_COLOR[s.status] ?? '#64748b'} tone="dot">{s.status}</Badge>}
          {s?.frames ? <span className="shrink-0 text-2xs text-muted">{s.frames} frames</span> : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {id && s?.status === 'active' && (
              <button
                onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); setMinimized(true); }}
                title="Minimize — keep the session running in a small bar"
                aria-label="Minimize"
                className="flex h-7 w-9 items-center justify-center rounded border border-border bg-bg pb-1 text-base leading-none text-muted-light hover:bg-card-hover hover:text-white"
              >
                &#8211;
              </button>
            )}
            {id && s?.status === 'active' && (
              <button
                onClick={toggleFull}
                title={full ? 'Restore from full screen' : 'Maximize to full screen'}
                aria-label={full ? 'Restore' : 'Maximize'}
                className="flex h-7 w-9 items-center justify-center rounded border border-border bg-bg text-xs leading-none text-muted-light hover:bg-card-hover hover:text-white"
              >
                {full ? '❐' : '□'}
              </button>
            )}
            <button
              onClick={stop}
              title={s?.status === 'active' ? 'End session' : 'Close'}
              aria-label={s?.status === 'active' ? 'End session' : 'Close'}
              className="flex h-7 w-9 items-center justify-center rounded border border-border bg-bg text-sm leading-none text-muted-light hover:border-danger hover:bg-danger hover:text-white"
            >
              &#10005;
            </button>
          </div>
        </div>
        {/* Toolbar: live session controls. */}
        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {id && s?.status === 'active' && (
              <span className="flex items-center gap-1" title="Lower quality = less bandwidth, faster on a slow link">
                <select
                  value={s?.quality ?? '480p'}
                  onChange={(e) => setQuality.mutate({ id, mode: e.target.value })}
                  disabled={setQuality.isPending}
                  className="rounded-md border border-border bg-bg px-1.5 py-1 text-2xs text-muted-light"
                >
                  {QUALITY_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
                <span className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-muted-light" title="Live bandwidth used by this session">
                  {fmtKbps(s?.bandwidthKbps ?? 0)}
                </span>
              </span>
            )}
            {id && s?.status === 'active' && (
              <button
                onClick={() => setRec.mutate({ id, on: !recOn })}
                disabled={setRec.isPending}
                title={recOn ? 'Stop recording this session (it keeps streaming)' : 'Start recording again — this opens a new file'}
                className={`rounded-md border px-2.5 py-1 text-2xs ${
                  recOn ? 'border-danger/50 bg-danger/10 text-danger' : 'border-border bg-bg text-muted-light hover:text-white'
                }`}
              >
                {recOn ? '⏺ Recording — stop' : '⏹ Not recording — start'}
              </button>
            )}
            {id && s?.status === 'active' && (
              <label
                title="Use this computer's keyboard and mouse to drive the remote desktop"
                className={`flex cursor-pointer select-none items-center gap-1.5 rounded-md border px-2.5 py-1 text-2xs ${
                  inputOn ? 'border-warning/50 bg-warning/10 text-warning' : 'border-border bg-bg text-muted-light hover:text-white'
                }`}
              >
                <input
                  type="checkbox"
                  checked={inputOn}
                  disabled={setInput.isPending}
                  onChange={(e) => setInput.mutate({ id, enabled: e.target.checked })}
                  className="h-3 w-3 accent-brand"
                />
                ⌨ Local keyboard &amp; mouse
              </label>
            )}
            {id && s?.status === 'active' && (
              <label
                title="Hear this computer's audio and microphone, and talk to the person at it"
                className={`flex cursor-pointer select-none items-center gap-1.5 rounded-md border px-2.5 py-1 text-2xs ${
                  audioOn ? 'border-warning/50 bg-warning/10 text-warning' : 'border-border bg-bg text-muted-light hover:text-white'
                }`}
              >
                <input
                  type="checkbox"
                  checked={audioOn}
                  disabled={setAudio.isPending}
                  onChange={(e) => setAudio.mutate({ id, enabled: e.target.checked })}
                  className="h-3 w-3 accent-brand"
                />
                🔊 Two-way audio
              </label>
            )}
            {audioOn && (
              <button
                onClick={() => setMicMuted((m) => !m)}
                title={micMuted ? 'Your microphone is muted — click to talk' : 'Mute your microphone (you can still hear)'}
                className={`rounded-md border px-2.5 py-1 text-2xs ${
                  micMuted ? 'border-danger/50 bg-danger/10 text-danger' : 'border-border bg-bg text-muted-light hover:text-white'
                }`}
              >
                {micMuted ? '🔇 Mic muted' : '🎙 Mic live'}
              </button>
            )}
            {id && s?.status === 'active' && (
              <button
                onClick={() => { const next = panel === 'comm' ? 'none' : 'comm'; setPanel(next); if (next === 'comm' && fsEntries.length === 0) browse(DRIVES); }}
                title="Chat with the person at this computer and send/receive files (encrypted)"
                className={`rounded-md border px-2.5 py-1 text-2xs ${panel === 'comm' ? 'border-brand/60 bg-brand/10 text-white' : 'border-border bg-bg text-muted-light hover:text-white'}`}
              >
                💬 Chat &amp; files
              </button>
            )}
            {recordingReady && (
              <button
                onClick={downloadRecording}
                title="Download the session recording to this computer"
                className="rounded-md border border-border bg-bg px-2.5 py-1 text-2xs text-muted-light hover:text-white"
              >
                ⬇ Save recording ({mb(s?.recordingBytes)} MB{parts > 1 ? `, ${parts} files` : ''})
              </button>
            )}
          </div>
        </div>

        {!id ? (
          // Scrollable options on top, a sticky footer with 2FA + Connect that always stays on screen so
          // the button is never hidden below the fold on a short window.
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
              <div className="rounded-lg border border-border bg-bg/50 p-3 text-2xs text-muted">
                This shows the <b className="text-white">main monitor</b> of {targetName} — the screen the person is actually looking at.
                Unlike RDP, it does not open a separate session or sign them out. The session is{' '}
                <b className="text-white">recorded</b> and the connection is written to the audit trail.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-2xs text-muted">
                  Console quality (lower = less bandwidth)
                  <select
                    value={startQuality}
                    onChange={(e) => setStartQuality(e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-2xs text-white"
                  >
                    {QUALITY_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                  </select>
                </label>
                <label className="block text-2xs text-muted">
                  Reason (audit trail)
                  <select
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-2xs text-white"
                  >
                    <option value="Support">Support</option>
                    <option value="Testing">Testing</option>
                    <option value="Demo">Demo</option>
                  </select>
                </label>
              </div>
              <RecordingsPanel />
            </div>
            <div className="mt-2 shrink-0 space-y-2 border-t border-border pt-2">
              {err && <div className="break-words rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{err}</div>}
              {twoFA.required && (
                <label className="block rounded-md border border-warning/40 bg-warning/10 px-2 py-2 text-2xs text-warning">
                  🔐 Two-factor required to connect — {twoFA.msg}
                  <input
                    value={twoFACode}
                    onChange={(e) => setTwoFACode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={(e) => { if (e.key === 'Enter' && twoFACode.length === 6) start(twoFACode); }}
                    inputMode="numeric"
                    autoFocus
                    placeholder="123456"
                    className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-center text-sm tracking-widest text-white"
                  />
                </label>
              )}
              <button
                onClick={() => start(twoFA.required ? twoFACode : undefined)}
                disabled={!reason.trim() || req.isPending || (twoFA.required && twoFACode.length !== 6)}
                className="w-full rounded-md bg-brand px-3 py-2 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50"
              >
                {req.isPending ? '◌ Connecting…' : twoFA.required ? 'Verify & connect' : 'Connect to this computer'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {/* Show the connection status only while it's still settling; once streaming, this line is
                just noise on top of the picture, so it's hidden. */}
            {s && s.status !== 'active' && (
              <div className="shrink-0 rounded-lg border border-border bg-bg/50 px-3 py-2 text-2xs text-muted"><StatusLine s={s} /></div>
            )}
            {!s && <div className="shrink-0 rounded-lg border border-border bg-bg/50 px-3 py-2 text-2xs text-muted">Starting…</div>}
            {dlErr && <div className="shrink-0 break-words rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">Could not download the recording: {dlErr}</div>}
            {inputErr && <div className="shrink-0 break-words rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">Keyboard/mouse not reaching the target: {inputErr}</div>}
            {audioOn && audioStat && (
              <div className={`shrink-0 break-words rounded border px-2 py-1 text-2xs ${audioStat.err || (audioStat.recv > 0 && audioStat.played === 0) ? 'border-danger/30 bg-danger/10 text-danger' : 'border-border bg-bg/50 text-muted'}`}>
                🎙→🖥 Your voice to {targetName}: {audioStat.recv === 0
                  ? (micMuted ? 'your mic is MUTED — click 🎙 Mic to talk' : 'no mic audio is being sent (check mic permission / that you are speaking)')
                  : audioStat.played === 0
                    ? `arriving but the remote speaker is not playing — ${audioStat.err || audioStat.info || 'device error'}`
                    : audioStat.peak < 200
                      ? `reaching the speaker, but your mic signal is near-silent (level ${audioStat.peak}) — check the right mic is selected and speak up`
                      : `playing on the remote speaker ✓ (level ${audioStat.peak}, ${audioStat.info})`}
              </div>
            )}
            {inputOn && (
              <div className="shrink-0 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-2xs text-warning">
                You are driving <b>{targetName}</b> — clicks and keystrokes go to that computer. Esc still exits full screen.
                {s?.inputEvents ? <> · {s.inputEvents} events sent</> : null}
              </div>
            )}
            {s?.status === 'active' && !recOn && (
              <div className="shrink-0 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-2xs text-warning">
                This session is <b>not being recorded</b>. Everything before you stopped is saved and still downloadable.
              </div>
            )}
            <div className="flex min-h-0 flex-1 gap-2">
              <div
                className={`flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-border bg-black ${full ? '' : 'min-h-[340px]'}`}
              >
                {s?.status === 'active' ? (
                  <canvas
                    ref={canvasRef}
                    aria-label={`${targetName} main monitor`}
                    // While the operator is driving the target, a double-click belongs to the remote
                    // desktop — stealing it for full screen would break every double-click over there.
                    onDoubleClick={inputOn ? undefined : toggleFull}
                    title={inputOn ? 'Your keyboard and mouse are driving this computer — the pointer you see is the remote one' : 'Double-click to toggle full screen'}
                    // object-contain on a canvas letterboxes the backing store (the target's real
                    // resolution) inside whatever box is available, at any aspect, with no cropping.
                    className={`h-full max-h-full w-full object-contain ${full ? '' : 'max-h-[60vh]'} ${inputOn ? 'cursor-default' : ''}`}
                  />
                ) : (
                  <div className="p-8 text-center text-2xs text-muted">
                    {s?.status === 'declined'
                      ? 'Nothing is shown — the user declined.'
                      : recordingReady
                        ? 'Session finished. Use “Save recording” above to download it to this computer.'
                        : 'Connecting to the console…'}
                  </div>
                )}
              </div>
              {s?.status === 'active' && panel === 'comm' && (
                <div className="flex w-[340px] shrink-0 flex-col rounded-lg border border-border bg-bg/60 p-2 text-2xs">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-white">💬 {targetName}</span>
                    <span className="shrink-0 text-emerald-400" title="Chat and files are sent over an encrypted (TLS) connection">🔒</span>
                    <button onClick={() => setShowFiles((f) => !f)} title="Send or download files" className={`shrink-0 rounded border px-1.5 py-0.5 ${showFiles ? 'border-brand/60 bg-brand/10 text-white' : 'border-border text-muted-light hover:text-white'}`}>📎 Files</button>
                  </div>

                  {/* Conversation — messages and transfer notes, WhatsApp-style. */}
                  <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded border border-border bg-bg p-1.5">
                    {chatLog.length === 0 && !xfer ? (
                      <div className="text-muted">No messages yet. Send one to open a chat window on {targetName}, or use 📎 to send a file.</div>
                    ) : (
                      <>
                        {chatLog.map((m, i) => (
                          <div key={i} className={`flex ${m.from === 'operator' ? 'justify-end' : 'justify-start'}`}>
                            <span className={`max-w-[85%] break-words rounded-lg px-2 py-1 ${m.from === 'operator' ? 'bg-brand/20 text-white' : 'bg-border/40 text-white'}`}>{m.text}</span>
                          </div>
                        ))}
                        {xfer && <div className="text-center text-muted">{xfer}</div>}
                      </>
                    )}
                  </div>

                  {/* Attach drawer: browse the remote machine and download, or store a file here. */}
                  {showFiles && (
                    <div className="mt-1 flex max-h-52 flex-col rounded border border-border bg-bg/60 p-1.5">
                      <div className="mb-1 flex flex-wrap items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-muted-light" title={`${pathLabel(fsPath)} — on the REMOTE PC ${targetName}, not your computer`}>📁 {!fsPath || fsPath === DRIVES ? `This PC · ${targetName}` : fsPath}</span>
                        <button onClick={() => browse(DRIVES)} title={`All drives on the remote PC ${targetName} (C:\\, D:\\ …)`} className="rounded border border-border px-1.5 py-0.5 text-muted-light hover:text-white">💽 This PC</button>
                        <button onClick={() => browse('')} title="The signed-in user's Desktop" className="rounded border border-border px-1.5 py-0.5 text-muted-light hover:text-white">🖥 Desktop</button>
                        {fsPath && fsPath !== DRIVES && <button onClick={() => browse(parentWinPath(fsPath))} className="rounded border border-border px-1.5 py-0.5 text-muted-light hover:text-white">↑ Up</button>}
                        {fsPath && fsPath !== DRIVES ? (
                          <label className="cursor-pointer rounded bg-brand px-2 py-0.5 text-white" title={`Store a file into ${fsPath}`}>
                            ⬆ Send file here
                            <input type="file" className="hidden" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void upload(f); e.currentTarget.value = ''; }} />
                          </label>
                        ) : (
                          <span className="rounded border border-border px-2 py-0.5 text-muted" title="Open a drive and folder first">⬆ Open a folder to send</span>
                        )}
                      </div>
                      {fsErr && <div className="mb-1 break-words text-danger">{fsErr}</div>}
                      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border bg-bg">
                        {fsEntries.length === 0 && !fsErr && <div className="px-1.5 py-2 text-muted">Empty folder.</div>}
                        {fsEntries.map((en, i) => (
                          <div key={i} className="flex items-center gap-1 border-b border-border/40 px-1.5 py-0.5">
                            {en.dir ? (
                              <button onClick={() => browse(joinWinPath(fsPath, en.name))} className="min-w-0 flex-1 truncate text-left text-white hover:text-brand" title={en.name}>{fsPath === DRIVES ? '💽' : '📂'} {en.name}</button>
                            ) : (
                              <>
                                <span className="min-w-0 flex-1 truncate text-muted-light" title={en.name}>📄 {en.name}</span>
                                <span className="shrink-0 text-muted">{fmtSize(en.size)}</span>
                                <button onClick={() => download(en.name)} title="Download to this computer" className="shrink-0 rounded border border-border px-1 text-muted-light hover:text-white">⬇</button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* WhatsApp-style attach menu: pick image / document / any file, and choose whether the
                      person at the remote PC picks where to save it, or it drops straight into the open folder. */}
                  {attachOpen && (
                    <div className="mt-1 rounded border border-border bg-bg p-1.5">
                      <div className="mb-1 text-muted">Send in chat — they get a <b className="text-white">Download</b> button and choose where to save:</div>
                      <div className="mb-1.5 flex flex-wrap gap-1">
                        <button onClick={() => pickAttach('image/*', 'offer')} className="flex-1 rounded border border-border px-1.5 py-1 text-muted-light hover:text-white">📷 Image</button>
                        <button onClick={() => pickAttach('.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv', 'offer')} className="flex-1 rounded border border-border px-1.5 py-1 text-muted-light hover:text-white">📄 Document</button>
                        <button onClick={() => pickAttach('*', 'offer')} className="flex-1 rounded border border-border px-1.5 py-1 text-muted-light hover:text-white">📎 Any file</button>
                        <button onClick={() => { setAttachOpen(false); folderRef.current?.click(); }} className="flex-1 rounded border border-border px-1.5 py-1 text-muted-light hover:text-white">📁 Folder</button>
                      </div>
                      <div className="mb-1 text-muted">Or store directly into <b className="text-white">{!fsPath || fsPath === DRIVES ? 'the open folder' : fsPath}</b>:</div>
                      <button
                        disabled={!fsPath || fsPath === DRIVES}
                        onClick={() => pickAttach('*', 'direct')}
                        className="w-full rounded border border-border px-1.5 py-1 text-muted-light hover:text-white disabled:opacity-40"
                        title={!fsPath || fsPath === DRIVES ? 'Open a folder in 📎 Files first' : `Store into ${fsPath}`}
                      >
                        ⬇ Store directly {(!fsPath || fsPath === DRIVES) && '(open a folder first)'}
                      </button>
                    </div>
                  )}
                  <input ref={attachRef} type="file" className="hidden" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) { const m = attachCfgRef.current.mode; if (m === 'offer') offerFile(f); else void upload(f, m === 'ask'); } e.currentTarget.value = ''; }} />
                  <input ref={folderRef} type="file" multiple className="hidden" onChange={(e) => { const fl = Array.from(e.currentTarget.files || []); if (fl.length) offerFolder(fl); e.currentTarget.value = ''; }} />

                  {/* Message box. */}
                  <div className="mt-1 flex gap-1">
                    <button onClick={() => setAttachOpen((o) => !o)} title="Send a file (image, document, any file)" className={`rounded border px-2 py-1 ${attachOpen ? 'border-brand/60 bg-brand/10 text-white' : 'border-border bg-bg text-muted-light hover:text-white'}`}>＋</button>
                    <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }} placeholder="Type a message…" className="flex-1 rounded border border-border bg-bg px-2 py-1 text-white" />
                    <button onClick={sendChat} className="rounded bg-brand px-2 py-1 text-white">Send</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
