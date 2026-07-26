import {
  MAX_BATCH,
  MAX_QUEUE,
  MAX_TEXT,
  OP_BUTTON,
  OP_CHAR,
  OP_KEY,
  OP_MOVE,
  OP_SCROLL,
  encodeOps,
  enqueue,
  inputAuditLine,
  sanitizeInput,
  type InputEvent,
} from './input';

describe('sanitizeInput', () => {
  it('keeps well-formed events and normalises the button', () => {
    const out = sanitizeInput([
      { k: 'move', x: 0.5, y: 0.25 },
      { k: 'down', b: 'r', x: 0, y: 1 },
      { k: 'up', x: 0.1, y: 0.1 }, // no button -> left
    ]);
    expect(out).toEqual([
      { k: 'move', x: 0.5, y: 0.25 },
      { k: 'down', b: 'r', x: 0, y: 1 },
      { k: 'up', b: 'l', x: 0.1, y: 0.1 },
    ]);
  });

  // Off-screen coordinates are the dangerous case: a click computed against the wrong geometry lands
  // somewhere the operator never aimed, on a real desktop. Dropping beats clamping.
  it('drops coordinates outside 0..1 rather than clamping them', () => {
    expect(sanitizeInput([{ k: 'move', x: 1.4, y: 0.5 }])).toEqual([]);
    expect(sanitizeInput([{ k: 'move', x: -0.01, y: 0.5 }])).toEqual([]);
    expect(sanitizeInput([{ k: 'down', b: 'l', x: NaN, y: 0.5 }])).toEqual([]);
    expect(sanitizeInput([{ k: 'move', x: 'a', y: 'b' }])).toEqual([]);
  });

  it('rejects virtual-key codes outside the Windows range', () => {
    expect(sanitizeInput([{ k: 'key', vk: 65, down: true }])).toEqual([{ k: 'key', vk: 65, down: true }]);
    expect(sanitizeInput([{ k: 'key', vk: 0, down: true }])).toEqual([]);
    expect(sanitizeInput([{ k: 'key', vk: 999, down: true }])).toEqual([]);
    expect(sanitizeInput([{ k: 'key', vk: 12.5, down: true }])).toEqual([]);
  });

  it('treats a missing down flag as key-up, never as a stuck key', () => {
    expect(sanitizeInput([{ k: 'key', vk: 65 }])).toEqual([{ k: 'key', vk: 65, down: false }]);
  });

  it('clamps scroll and drops a zero delta', () => {
    expect(sanitizeInput([{ k: 'scroll', d: 99999, x: 0.5, y: 0.5 }])).toEqual([{ k: 'scroll', d: 600, x: 0.5, y: 0.5 }]);
    expect(sanitizeInput([{ k: 'scroll', d: -99999, x: 0.5, y: 0.5 }])).toEqual([{ k: 'scroll', d: -600, x: 0.5, y: 0.5 }]);
    expect(sanitizeInput([{ k: 'scroll', d: 0, x: 0.5, y: 0.5 }])).toEqual([]);
  });

  it('truncates pasted text and caps the batch', () => {
    const long = 'x'.repeat(MAX_TEXT + 50);
    expect(sanitizeInput([{ k: 'text', t: long }])).toEqual([{ k: 'text', t: 'x'.repeat(MAX_TEXT) }]);
    const flood = Array.from({ length: MAX_BATCH + 40 }, () => ({ k: 'move', x: 0.5, y: 0.5 }));
    expect(sanitizeInput(flood)).toHaveLength(MAX_BATCH);
  });

  it('ignores junk instead of throwing', () => {
    expect(sanitizeInput(null)).toEqual([]);
    expect(sanitizeInput('nope')).toEqual([]);
    expect(sanitizeInput([null, 42, { k: 'unknown' }, {}])).toEqual([]);
  });
});

describe('enqueue', () => {
  it('drops the OLDEST events when the backlog overflows — a stale mouse position is worthless', () => {
    const old: InputEvent[] = Array.from({ length: MAX_QUEUE }, (_, i) => ({ k: 'key', vk: 65, down: i % 2 === 0 }));
    const fresh: InputEvent[] = [{ k: 'move', x: 0.9, y: 0.9 }];
    const q = enqueue(old, fresh);
    expect(q).toHaveLength(MAX_QUEUE);
    expect(q[q.length - 1]).toEqual({ k: 'move', x: 0.9, y: 0.9 });
  });
});

describe('encodeOps', () => {
  it('emits move-then-press so a click never depends on an earlier packet arriving', () => {
    const ops = encodeOps([{ k: 'down', b: 'r', x: 0.5, y: 1 }]);
    expect(ops).toEqual([OP_MOVE, 32768, 65535, 0, OP_BUTTON, 1, 1, 0]);
  });

  it('encodes movement in absolute 0..65535 screen units', () => {
    expect(encodeOps([{ k: 'move', x: 0, y: 1 }])).toEqual([OP_MOVE, 0, 65535, 0]);
  });

  it('encodes scroll positioned at the pointer', () => {
    expect(encodeOps([{ k: 'scroll', d: -120, x: 0.5, y: 0.5 }])).toEqual([OP_MOVE, 32768, 32768, 0, OP_SCROLL, -120, 0, 0]);
  });

  it('encodes keys as down/up pairs the caller controls', () => {
    expect(encodeOps([{ k: 'key', vk: 65, down: true }, { k: 'key', vk: 65, down: false }]))
      .toEqual([OP_KEY, 65, 1, 0, OP_KEY, 65, 0, 0]);
  });

  it('walks text by UTF-16 code unit so characters outside the BMP survive', () => {
    const ops = encodeOps([{ k: 'text', t: 'A😀' }]); // 'A' + a surrogate pair = 3 code units
    expect(ops).toHaveLength(3 * 2 * 4);
    expect(ops.slice(0, 8)).toEqual([OP_CHAR, 65, 1, 0, OP_CHAR, 65, 0, 0]);
  });

  it('produces a flat multiple of 4 for any input — the agent reads fixed-width groups', () => {
    const ops = encodeOps([
      { k: 'move', x: 0.1, y: 0.2 },
      { k: 'down', b: 'l', x: 0.1, y: 0.2 },
      { k: 'up', b: 'l', x: 0.1, y: 0.2 },
      { k: 'scroll', d: 120, x: 0.3, y: 0.4 },
      { k: 'key', vk: 13, down: true },
      { k: 'text', t: 'hi' },
    ]);
    expect(ops.length % 4).toBe(0);
  });
});

describe('inputAuditLine', () => {
  it('names who took the keyboard, on which machine', () => {
    expect(inputAuditLine(true, 'ops@example.com', 'WIN-TEST')).toContain('Remote INPUT enabled by ops@example.com on WIN-TEST');
    expect(inputAuditLine(false, 'ops@example.com', 'WIN-TEST')).toContain('view-only');
  });
});
