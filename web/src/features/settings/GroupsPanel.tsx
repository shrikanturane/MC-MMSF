'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import { useGroups, useCreateGroup, useUpdateGroup, useDeleteGroup, useAddGroupMember, useRemoveGroupMember, useUsers } from '@/lib/hooks';
import type { GroupItem, GroupAccess } from '@/lib/types';
import { useBranding } from '@/lib/branding';
import { PLATFORM_MODULES, HELP_SECTIONS } from '@/lib/modules';
import { WIDGET_CATALOG } from '@/features/board/widgets';

const VIA = [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['both', 'Email + WhatsApp']];

/** Card-wrapped variant (kept for any standalone usage). */
export function GroupsPanel() {
  return (
    <Card title="User Groups / Teams" className="col-span-12" bodyClassName="p-0" action={<GroupsAddInline />}>
      <GroupsManager />
    </Card>
  );
}

/** Inline "add group" control — used as the card action when GroupsManager is embedded elsewhere. */
export function GroupsAddInline() {
  const create = useCreateGroup();
  const [name, setName] = useState('');
  const add = () => {
    if (!name.trim()) return;
    create.mutate({ name });
    setName('');
  };
  return (
    <div className="flex items-center gap-2">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group name" className="w-40 rounded-md border border-border bg-bg px-2.5 py-1 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
      <button onClick={add} disabled={create.isPending} className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">+ Add</button>
    </div>
  );
}

/** Content-only group manager (no Card wrapper) so it can live inside the RBAC tabs. */
export function GroupsManager() {
  const groups = useGroups();
  return (
    <>
      <div className="border-b border-border px-4 py-2 text-2xs text-muted">
        Target a whole group from any notification: add a <b className="text-white">Group</b> channel (Security → Notification Channels) and alerts fan out to every member by their email and/or WhatsApp.
      </div>
      <div className="divide-y divide-border-soft">
        {groups.data?.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">No groups yet.</div>}
        {groups.data?.map((g) => <GroupRow key={g.id} group={g} />)}
      </div>
    </>
  );
}

function GroupRow({ group }: { group: GroupItem }) {
  const update = useUpdateGroup();
  const del = useDeleteGroup();
  const addMember = useAddGroupMember();
  const removeMember = useRemoveGroupMember();
  const users = useUsers();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');

  const nonMembers = (users.data ?? []).filter((u) => !group.members.some((m) => m.id === u.id));

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left">
          <span className="text-muted">{open ? '▾' : '▸'}</span>
          <span>
            <span className="flex items-center gap-1.5 text-sm font-medium text-white">{group.name}
              {group.access?.governs && <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-normal text-brand">{group.access.all ? 'full access' : `${group.access.modules.length} modules`}</span>}
            </span>
            <span className="block text-2xs text-muted">{group.memberCount} member(s) · via {group.notifyVia}</span>
          </span>
        </button>
        <div className="flex items-center gap-2">
          <select
            value={group.notifyVia}
            onChange={(e) => update.mutate({ id: group.id, notifyVia: e.target.value })}
            className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:border-brand focus:outline-none"
            title="How alerts reach this group"
          >
            {VIA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button onClick={() => confirm(`Delete group "${group.name}"?`) && del.mutate(group.id)} className="text-2xs text-danger hover:underline">delete</button>
        </div>
      </div>

      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg/40 p-3">
          <div className="flex flex-wrap gap-1.5">
            {group.members.map((m) => (
              <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-2xs text-white">
                {m.name}
                <button onClick={() => removeMember.mutate({ groupId: group.id, userId: m.id })} className="text-danger hover:text-white" title="Remove">×</button>
              </span>
            ))}
            {group.members.length === 0 && <span className="text-2xs text-muted">No members yet.</span>}
          </div>
          <div className="flex items-center gap-2">
            <select value={pick} onChange={(e) => setPick(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:border-brand focus:outline-none">
              <option value="">Add member…</option>
              {nonMembers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
            </select>
            <button
              onClick={() => { if (pick) { addMember.mutate({ groupId: group.id, userId: pick }); setPick(''); } }}
              disabled={!pick}
              className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-brand hover:text-white disabled:opacity-40"
            >
              Add
            </button>
          </div>
          <GroupAccessEditor group={group} />
        </div>
      )}
    </div>
  );
}

/** Per-group permission policy: which modules / widgets / help / pages members may access. */
function GroupAccessEditor({ group }: { group: GroupItem }) {
  const update = useUpdateGroup();
  const { layout } = useBranding();
  const [a, setA] = useState<GroupAccess>(group.access ?? { governs: false, all: false, modules: [], widgets: [], help: [], pages: [] });
  const [saved, setSaved] = useState(false);
  const pages: [string, string][] = (layout.customPages ?? []).map((p) => [p.id, p.label]);
  const patch = (p: Partial<GroupAccess>) => { setA((prev) => ({ ...prev, ...p })); setSaved(false); };
  const toggle = (kind: 'modules' | 'widgets' | 'help' | 'pages', key: string) => {
    const cur = a[kind]; patch({ [kind]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] } as Partial<GroupAccess>);
  };
  const setAll = (kind: 'modules' | 'widgets' | 'help' | 'pages', keys: string[]) => patch({ [kind]: keys } as Partial<GroupAccess>);
  const save = async () => { await update.mutateAsync({ id: group.id, access: a }); setSaved(true); };

  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-brand/25 bg-brand/[0.04] p-3">
      <div className="text-2xs font-semibold text-brand">🔐 Access policy</div>
      <label className="flex items-center gap-2 text-2xs font-medium text-white">
        <input type="checkbox" checked={a.governs} onChange={(e) => patch({ governs: e.target.checked })} className="accent-brand" />
        This group controls access — members see <b>only</b> what is allowed below
      </label>
      {!a.governs ? (
        <div className="text-[10px] text-muted">Off = notification-only group (no access restriction). Turn on to make this a permission group.</div>
      ) : (
        <>
          <label className="flex items-center gap-2 text-2xs text-muted-light">
            <input type="checkbox" checked={a.all} onChange={(e) => patch({ all: e.target.checked })} className="accent-emerald-500" />
            Full access (every module, widget, help section &amp; page)
          </label>
          {!a.all && (
            <div className="space-y-2">
              <Checklist title="Modules" items={PLATFORM_MODULES.map((m) => [m.key, m.label])} sel={a.modules} onToggle={(k) => toggle('modules', k)} onAll={() => setAll('modules', PLATFORM_MODULES.map((m) => m.key))} onNone={() => setAll('modules', [])} />
              <Checklist title="Dashboard widgets / cards" items={WIDGET_CATALOG.map((w) => [w.kind, w.label])} sel={a.widgets} onToggle={(k) => toggle('widgets', k)} onAll={() => setAll('widgets', WIDGET_CATALOG.map((w) => w.kind))} onNone={() => setAll('widgets', [])} />
              <Checklist title="Help sections" items={HELP_SECTIONS.map((h) => [h.id, h.label])} sel={a.help} onToggle={(k) => toggle('help', k)} onAll={() => setAll('help', HELP_SECTIONS.map((h) => h.id))} onNone={() => setAll('help', [])} />
              {pages.length > 0 && <Checklist title="Custom pages" items={pages} sel={a.pages} onToggle={(k) => toggle('pages', k)} onAll={() => setAll('pages', pages.map((p) => p[0]))} onNone={() => setAll('pages', [])} />}
            </div>
          )}
        </>
      )}
      <div className="flex items-center gap-2">
        <button onClick={save} disabled={update.isPending} className="rounded-md bg-brand px-3 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{update.isPending ? 'Saving…' : 'Save access policy'}</button>
        {saved && <span className="text-2xs text-emerald-300">✓ Saved — members refresh on next sign-in / reload</span>}
      </div>
    </div>
  );
}

function Checklist({ title, items, sel, onToggle, onAll, onNone }: { title: string; items: [string, string][]; sel: string[]; onToggle: (k: string) => void; onAll: () => void; onNone: () => void }) {
  return (
    <div className="rounded-md border border-border bg-bg/50 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-2xs font-semibold text-white">{title} <span className="rounded bg-border/50 px-1 py-0.5 font-normal text-muted">{sel.length}/{items.length}</span></span>
        <span className="flex items-center gap-1 text-[10px]"><button onClick={onAll} className="rounded border border-border px-1.5 py-0.5 text-muted hover:text-white">All</button><button onClick={onNone} className="rounded border border-border px-1.5 py-0.5 text-muted hover:text-white">None</button></span>
      </div>
      <div className="grid max-h-40 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto pr-1 sm:grid-cols-3">
        {items.map(([k, label]) => {
          const on = sel.includes(k);
          return (
            <label key={k} className={`flex cursor-pointer items-center gap-1.5 truncate rounded px-1 py-0.5 text-[11px] transition ${on ? 'text-white' : 'text-muted-light hover:bg-card-hover/40'}`} title={label}>
              <input type="checkbox" checked={on} onChange={() => onToggle(k)} className="shrink-0 accent-brand" />
              <span className="truncate">{label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
