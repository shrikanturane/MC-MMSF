/**
 * Remote keyboard & mouse — the wire format, and the rules for what may cross it. Pure: no I/O.
 *
 * Viewing someone's screen and DRIVING it are different powers, so they are separate switches. Input is
 * off until an operator turns it on for a specific session, and the server re-checks that flag on every
 * batch — a viewer that keeps sending after it was turned off is refused, not merely ignored by the UI.
 *
 * Coordinates are NORMALISED (0..1 of the screen), never pixels. The operator's browser has no idea what
 * resolution or DPI scaling the target is running, and a click computed against the wrong geometry lands
 * somewhere else entirely — on someone's real desktop. The agent multiplies by its own screen size.
 *
 * Events are encoded for the agent as flat groups of 4 integers (see `encodeOps`) rather than JSON: the
 * injection runs inside a C# worker thread on the target, and handing it a fixed-width int array avoids
 * parsing structured data in the one place that must never throw.
 */

export type MouseButton = 'l' | 'r' | 'm';

export type InputEvent =
  | { k: 'move'; x: number; y: number }
  | { k: 'down'; b: MouseButton; x: number; y: number }
  | { k: 'up'; b: MouseButton; x: number; y: number }
  | { k: 'scroll'; d: number; x: number; y: number }
  | { k: 'key'; vk: number; down: boolean }
  | { k: 'text'; t: string };

/** One batch may not be unbounded: a runaway viewer must not be able to queue work for minutes. */
export const MAX_BATCH = 120;
/** Server-side backlog cap. Older events are dropped first — stale mouse positions are worthless. */
export const MAX_QUEUE = 400;
/** Typed text is clamped so a paste cannot become a keystroke flood. */
export const MAX_TEXT = 256;

const BUTTONS: MouseButton[] = ['l', 'r', 'm'];

/** 0..1, finite, or null. Anything else is a bug or an attack; either way it must not reach the target. */
function coord(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Validate an untrusted batch into events the agent may act on. Anything malformed is DROPPED rather
 * than corrected: a half-understood mouse event is worse than a missing one, because the operator sees
 * the pointer land somewhere they did not aim.
 */
export function sanitizeInput(raw: unknown): InputEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: InputEvent[] = [];
  for (const e of raw.slice(0, MAX_BATCH)) {
    if (!e || typeof e !== 'object') continue;
    const k = String((e as any).k || '');
    if (k === 'move' || k === 'down' || k === 'up' || k === 'scroll') {
      const x = coord((e as any).x);
      const y = coord((e as any).y);
      if (x === null || y === null) continue;
      if (k === 'move') { out.push({ k: 'move', x, y }); continue; }
      if (k === 'scroll') {
        const d = Number((e as any).d);
        if (!Number.isFinite(d) || d === 0) continue;
        // One wheel notch is 120; clamp to a few notches so a trackpad burst cannot scroll a page to its end.
        out.push({ k: 'scroll', d: Math.max(-600, Math.min(600, Math.round(d))), x, y });
        continue;
      }
      const b = BUTTONS.includes((e as any).b) ? ((e as any).b as MouseButton) : 'l';
      out.push({ k: k as 'down' | 'up', b, x, y });
      continue;
    }
    if (k === 'key') {
      const vk = Number((e as any).vk);
      // Windows virtual-key codes are 1..254. Out-of-range means the browser sent something we cannot map.
      if (!Number.isInteger(vk) || vk < 1 || vk > 254) continue;
      out.push({ k: 'key', vk, down: (e as any).down === true });
      continue;
    }
    if (k === 'text') {
      const t = String((e as any).t ?? '');
      if (!t) continue;
      out.push({ k: 'text', t: t.slice(0, MAX_TEXT) });
    }
  }
  return out;
}

/** Newest-wins backlog: keep the most recent MAX_QUEUE events, drop the oldest. */
export function enqueue(queue: InputEvent[], incoming: InputEvent[]): InputEvent[] {
  const merged = [...queue, ...incoming];
  return merged.length > MAX_QUEUE ? merged.slice(merged.length - MAX_QUEUE) : merged;
}

// Op codes shared with the agent's McmfShot.Send. Keep in sync with mcmf-tray-agent.ps1.
export const OP_MOVE = 1;
export const OP_BUTTON = 2;
export const OP_SCROLL = 3;
export const OP_KEY = 4;
export const OP_CHAR = 5;

/** Absolute mouse coordinates on Windows are 0..65535 across the virtual screen. */
const ABS = 65535;

/**
 * Flatten events into the agent's [op, a, b, c] int stream.
 *
 * A button press carries its own position and is emitted as move-then-press: the browser tells us where
 * the operator clicked, and relying on a previously-sent move to have already landed would misplace the
 * click whenever a packet was dropped or reordered.
 */
export function encodeOps(events: InputEvent[]): number[] {
  const ops: number[] = [];
  const push = (op: number, a: number, b: number, c: number) => ops.push(op, a, b, c);
  const ax = (v: number) => Math.round(v * ABS);
  for (const e of events) {
    switch (e.k) {
      case 'move':
        push(OP_MOVE, ax(e.x), ax(e.y), 0);
        break;
      case 'down':
      case 'up':
        push(OP_MOVE, ax(e.x), ax(e.y), 0);
        push(OP_BUTTON, BUTTONS.indexOf(e.b), e.k === 'down' ? 1 : 0, 0);
        break;
      case 'scroll':
        push(OP_MOVE, ax(e.x), ax(e.y), 0);
        push(OP_SCROLL, e.d, 0, 0);
        break;
      case 'key':
        push(OP_KEY, e.vk, e.down ? 1 : 0, 0);
        break;
      case 'text':
        // Unicode injection is per-code-unit, down then up. Surrogate pairs survive because we walk code
        // units rather than code points — Windows expects exactly that for characters outside the BMP.
        for (let i = 0; i < e.t.length; i++) {
          push(OP_CHAR, e.t.charCodeAt(i), 1, 0);
          push(OP_CHAR, e.t.charCodeAt(i), 0, 0);
        }
        break;
    }
  }
  return ops;
}

/** Audit wording. Handing someone the keyboard of a live desktop is a decision, so it reads like one. */
export function inputAuditLine(enabled: boolean, who: string, target: string): string {
  return enabled
    ? `Remote INPUT enabled by ${who} on ${target} — the operator can now use the keyboard and mouse of this computer`
    : `Remote input disabled by ${who} on ${target} — view-only again`;
}

/** Audit line for the two-way audio toggle — a distinct escalation from being watched or typed on. */
export function audioAuditLine(enabled: boolean, who: string, target: string): string {
  return enabled
    ? `Remote AUDIO enabled by ${who} on ${target} — the operator can now hear this computer's audio and microphone, and speak to it`
    : `Remote audio disabled by ${who} on ${target} — microphones and speakers no longer shared`;
}
