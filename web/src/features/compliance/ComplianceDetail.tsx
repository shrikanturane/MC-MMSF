'use client';

import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui';
import { useComplianceCreate, useComplianceDelete, useComplianceItems, useComplianceUpdate } from '@/lib/hooks';
import type { ComplianceItem } from '@/lib/types';

const NEXT: Record<string, string> = { passed: 'failed', failed: 'na', na: 'passed' };
const STATUS_META: Record<string, { color: string; icon: string; label: string }> = {
  passed: { color: '#22c55e', icon: '✓', label: 'Completed' },
  failed: { color: '#ef4444', icon: '✕', label: 'Not done' },
  na: { color: '#64748b', icon: '–', label: 'N/A' },
};

export function ComplianceDetail({ onClose }: { onClose: () => void }) {
  const items = useComplianceItems();
  const create = useComplianceCreate();
  const update = useComplianceUpdate();
  const del = useComplianceDelete();

  const standards = useMemo(() => [...new Set((items.data ?? []).map((i) => i.standard))], [items.data]);
  const [std, setStd] = useState<string>('');
  const active = std || standards[0] || 'CIS Benchmark';
  const rows = (items.data ?? []).filter((i) => i.standard === active);

  const [newControl, setNewControl] = useState('');
  const addControl = () => {
    if (!newControl.trim()) return;
    create.mutate({ standard: active, control: newControl.trim(), status: 'failed' });
    setNewControl('');
  };

  const score = useMemo(() => {
    const done = rows.filter((r) => r.status === 'passed').length;
    const denom = rows.filter((r) => r.status !== 'na').length;
    return denom ? Math.round((done / denom) * 100) : 100;
  }, [rows]);

  return (
    <Modal title="Compliance Benchmarks" subtitle="Track controls per standard — click a status to cycle, edit or add controls" onClose={onClose} wide>
      {/* Standard tabs */}
      <div className="mb-3 flex flex-wrap gap-2">
        {standards.map((s) => {
          const sRows = (items.data ?? []).filter((i) => i.standard === s);
          const done = sRows.filter((r) => r.status === 'passed').length;
          const denom = sRows.filter((r) => r.status !== 'na').length;
          const sc = denom ? Math.round((done / denom) * 100) : 100;
          return (
            <button key={s} onClick={() => setStd(s)} className={`rounded-lg border px-3 py-1.5 text-xs ${active === s ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted-light hover:text-white'}`}>
              {s} <span className="text-2xs text-muted">· {sc}%</span>
            </button>
          );
        })}
      </div>

      {/* Summary bar */}
      <div className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-card-hover/30 px-3 py-2">
        <div className="text-lg font-semibold" style={{ color: score >= 85 ? '#22c55e' : score >= 70 ? '#f59e0b' : '#ef4444' }}>{score}%</div>
        <div className="text-2xs text-muted">
          {rows.filter((r) => r.status === 'passed').length} completed · {rows.filter((r) => r.status === 'failed').length} not done · {rows.filter((r) => r.status === 'na').length} N/A
        </div>
      </div>

      {/* Controls list */}
      <div className="max-h-[44vh] space-y-1.5 overflow-y-auto">
        {rows.map((r) => (
          <ControlRow key={r.id} item={r} onCycle={() => update.mutate({ id: r.id, status: NEXT[r.status] })} onRename={(v) => update.mutate({ id: r.id, control: v })} onDelete={() => del.mutate(r.id)} />
        ))}
        {rows.length === 0 && <div className="py-6 text-center text-2xs text-muted">No controls. Add one below.</div>}
      </div>

      {/* Add control */}
      <div className="mt-3 flex gap-2">
        <input value={newControl} onChange={(e) => setNewControl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addControl()} placeholder={`New control for ${active}…`} className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        <button onClick={addControl} disabled={create.isPending} className="rounded-lg bg-brand px-4 py-2 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">+ Add</button>
      </div>
    </Modal>
  );
}

function ControlRow({ item, onCycle, onRename, onDelete }: { item: ComplianceItem; onCycle: () => void; onRename: (v: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(item.control);
  const m = STATUS_META[item.status] ?? STATUS_META.na;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-soft bg-card/40 px-3 py-2">
      <button onClick={onCycle} title={`${m.label} — click to change`} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-bold" style={{ color: '#fff', background: m.color }}>
        {m.icon}
      </button>
      {editing ? (
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => { setEditing(false); if (val.trim() && val !== item.control) onRename(val.trim()); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { setEditing(false); if (val.trim() && val !== item.control) onRename(val.trim()); } }}
          className="flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-white focus:border-brand focus:outline-none"
        />
      ) : (
        <span className="flex-1 truncate text-xs text-white" onDoubleClick={() => setEditing(true)} title="double-click to edit">{item.control}</span>
      )}
      <span className="shrink-0 text-2xs capitalize" style={{ color: m.color }}>{m.label}</span>
      {item.source === 'defender' && <span className="shrink-0 rounded bg-brand/15 px-1.5 py-0.5 text-2xs text-brand">defender</span>}
      <button onClick={() => setEditing(true)} className="shrink-0 text-2xs text-muted hover:text-white">edit</button>
      <button onClick={onDelete} className="shrink-0 text-2xs text-danger hover:underline">✕</button>
    </div>
  );
}
