'use client';

import { useState } from 'react';

/**
 * A custom, editable name shown centered at the top of a widget's body. Stored per-widget in
 * panel.cfg.label / panel.cfg.hideLabel and persisted via onConfig. Lets an operator name (e.g.)
 * a Network Devices / IP-Host Monitor / Guest Agents widget per scope, and hide the name if unwanted.
 */
export function WidgetLabel({ label, hidden, onConfig }: { label?: string; hidden?: boolean; onConfig?: (patch: { label?: string; hideLabel?: boolean }) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(label ?? '');
  const text = (label ?? '').trim();

  if (hidden) {
    // Hidden: nothing for viewers; a tiny "show name" affordance for editors.
    return onConfig ? (
      <div className="flex justify-center">
        <button onClick={() => onConfig({ hideLabel: false })} className="text-[10px] text-muted hover:text-white" title="Show the panel name">▾ show name</button>
      </div>
    ) : null;
  }

  if (editing) {
    const commit = () => { onConfig?.({ label: val.trim() }); setEditing(false); };
    return (
      <div className="flex items-center justify-center gap-1 py-1">
        <input
          autoFocus value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          onBlur={commit}
          placeholder="Name this panel…"
          className="w-52 max-w-full rounded border border-border bg-bg px-2 py-0.5 text-center text-sm text-white focus:border-brand focus:outline-none"
        />
        <button onMouseDown={(e) => e.preventDefault()} onClick={commit} className="text-2xs text-brand" title="Save">✓</button>
      </div>
    );
  }

  // Empty: render nothing for viewers; a faint, unobtrusive "name" affordance for editors (no noisy
  // "Unnamed panel" placeholder taking space on every widget).
  if (!text) {
    return onConfig ? (
      <div className="flex justify-center py-0.5">
        <button onClick={() => { setVal(''); setEditing(true); }} className="text-[10px] text-muted/50 transition hover:text-brand" title="Name this panel">✎ name</button>
      </div>
    ) : null;
  }

  return (
    <div className="group/lbl flex items-center justify-center gap-1.5 py-1 text-center">
      <span className="text-sm font-semibold text-white">{text}</span>
      {onConfig && (
        <span className="flex items-center gap-1 opacity-0 transition group-hover/lbl:opacity-100">
          <button onClick={() => { setVal(text); setEditing(true); }} className="text-2xs text-muted hover:text-white" title="Rename">✎</button>
          <button onClick={() => onConfig({ hideLabel: true })} className="text-2xs text-muted hover:text-white" title="Hide name">🚫</button>
        </span>
      )}
    </div>
  );
}
