'use client';

import { useState } from 'react';
import { Badge, Card, Modal } from '@/components/ui';
import { PasswordInput } from '@/components/PasswordInput';
import { useUsers, useUserRoles, useCreateUser, useUpdateUser, useSetUserPassword, useDeleteUser, useGroups } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import type { Role, RoleSpec, User } from '@/lib/types';
import { GroupsManager, GroupsAddInline } from './GroupsPanel';

const ROLE_COLORS: Record<Role, string> = { admin: '#a855f7', operator: '#3b82f6', viewer: '#64748b' };
const ROLE_LABELS: Record<Role, string> = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' };

type RbacTab = 'users' | 'roles' | 'groups';
const TABS: { key: RbacTab; label: string }[] = [
  { key: 'users', label: 'Users' },
  { key: 'roles', label: 'Roles & Permissions' },
  { key: 'groups', label: 'Groups / Teams' },
];

export function UsersPanel() {
  const roles = useUserRoles();
  const [tab, setTab] = useState<RbacTab>('users');
  const [adding, setAdding] = useState(false);

  const action =
    tab === 'users' ? (
      <button onClick={() => setAdding(true)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ Add User</button>
    ) : tab === 'groups' ? (
      <GroupsAddInline />
    ) : null;

  return (
    <Card title="Users & Access (RBAC)" className="col-span-12" bodyClassName="p-0" action={action}>
      <div className="flex gap-1 border-b border-border px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-t-lg px-3 py-1.5 text-xs font-medium transition ${tab === t.key ? 'bg-card text-white' : 'text-muted hover:text-white'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab roles={roles.data ?? []} adding={adding} setAdding={setAdding} />}
      {tab === 'roles' && <RolesTab roles={roles.data ?? []} />}
      {tab === 'groups' && <GroupsManager />}
    </Card>
  );
}

function UsersTab({ roles, adding, setAdding }: { roles: RoleSpec[]; adding: boolean; setAdding: (v: boolean) => void }) {
  const users = useUsers();
  const del = useDeleteUser();
  const [editing, setEditing] = useState<User | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const remove = async (u: User) => {
    if (!confirm(`Delete user "${u.name}"? This cannot be undone.`)) return;
    setErr(null);
    try {
      await del.mutateAsync(u.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      {err && <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-2xs text-danger">{err}</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5 font-medium">User</th>
              <th className="px-4 py-2.5 font-medium">Contact</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">MFA</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Added</th>
              <th className="px-4 py-2.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="border-b border-border-soft last:border-0 hover:bg-card-hover">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full text-2xs font-bold text-white" style={{ background: ROLE_COLORS[u.role] }}>
                      {u.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
                    </span>
                    <div>
                      <div className="font-medium text-white">{u.name}</div>
                      <div className="text-2xs text-muted">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-2xs text-muted-light">{u.contact || '—'}</td>
                <td className="px-4 py-2.5"><Badge color={ROLE_COLORS[u.role]} tone="soft">{ROLE_LABELS[u.role]}</Badge></td>
                <td className="px-4 py-2.5">
                  {u.twoFactorEnabled
                    ? <span className="rounded bg-success/15 px-1.5 py-0.5 text-2xs text-success">🔐 Enrolled</span>
                    : u.require2fa
                      ? <span className="rounded bg-warning/15 px-1.5 py-0.5 text-2xs text-warning" title="Required — enrols on next sign-in">🔐 Required</span>
                      : <span className="rounded bg-border/40 px-1.5 py-0.5 text-2xs text-muted">off</span>}
                </td>
                <td className="px-4 py-2.5"><Badge color={u.status === 'active' ? '#22c55e' : '#f59e0b'} tone="dot">{u.status}</Badge></td>
                <td className="px-4 py-2.5 text-2xs text-muted">{timeAgo(u.createdAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-2">
                    <button onClick={() => { setErr(null); setEditing(u); }} className="text-2xs text-brand hover:underline">Edit</button>
                    <button onClick={() => remove(u)} className="text-2xs text-danger hover:underline">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {users.data?.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">No users yet. Click <b className="text-white">+ Add User</b>.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(adding || editing) && (
        <UserModal
          user={editing}
          roles={roles}
          onClose={() => { setAdding(false); setEditing(null); }}
        />
      )}
    </>
  );
}

function RolesTab({ roles }: { roles: RoleSpec[] }) {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {roles.map((r) => (
          <div key={r.role} className="rounded-xl border border-border bg-card/60 p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: ROLE_COLORS[r.role] }} />
              <span className="text-xs font-semibold text-white">{r.label}</span>
            </div>
            <div className="mb-2 text-2xs text-muted">{r.description}</div>
            <ul className="space-y-0.5">
              {r.permissions.map((p) => (
                <li key={p} className="flex items-start gap-1 text-2xs text-muted-light"><span className="text-success">✓</span> {p}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function UserModal({ user, roles, onClose }: { user: User | null; roles: RoleSpec[]; onClose: () => void }) {
  const create = useCreateUser();
  const update = useUpdateUser();
  const setPassword = useSetUserPassword();
  const groupsQ = useGroups();
  const isEdit = !!user;
  const [f, setF] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    contact: user?.contact ?? '',
    role: (user?.role ?? 'viewer') as Role,
    status: user?.status ?? 'active',
    password: '',
    groupId: '', // mandatory access group for new users
    monitorGroups: (user?.monitorGroups ?? []).join(', '),
    require2fa: user?.require2fa ?? false,
  });
  const [err, setErr] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || setPassword.isPending;
  const groups = f.monitorGroups.split(',').map((s) => s.trim()).filter(Boolean);

  const save = async () => {
    setErr(null);
    try {
      if (isEdit) {
        await update.mutateAsync({ id: user!.id, name: f.name, email: f.email, contact: f.contact, role: f.role, status: f.status, monitorGroups: groups, require2fa: f.require2fa });
        if (f.password) await setPassword.mutateAsync({ id: user!.id, password: f.password });
      } else {
        if (!f.groupId) { setErr('Select an access group — it determines what this user can see.'); return; }
        await create.mutateAsync({ name: f.name, email: f.email, contact: f.contact, role: f.role, status: f.status, password: f.password, monitorGroups: groups, groupId: f.groupId });
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal title={isEdit ? 'Edit User' : 'Add User'} subtitle={isEdit ? user!.email : 'Create an account and assign a role'} onClose={onClose}>
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger">{err}</div>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Full Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} className="col-span-2" />
          <Field label="Email" value={f.email} onChange={(v) => setF({ ...f, email: v })} type="email" className="col-span-2" />
          <Field label="Contact / Phone" value={f.contact} onChange={(v) => setF({ ...f, contact: v })} className="col-span-2" />

          <label className="block">
            <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Role</span>
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })} className="w-full rounded-lg border border-border bg-bg px-2 py-2 text-sm text-white focus:border-brand focus:outline-none">
              {(roles.length ? roles : [{ role: 'admin', label: 'Administrator' }, { role: 'operator', label: 'Operator' }, { role: 'viewer', label: 'Viewer' }] as RoleSpec[]).map((r) => (
                <option key={r.role} value={r.role}>{r.label}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Status</span>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2 py-2 text-sm text-white focus:border-brand focus:outline-none">
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </label>

          {!isEdit && (
            <div className="col-span-2 rounded-lg border border-brand/30 bg-brand/[0.04] p-2.5">
              <label className="block">
                <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-brand">Access Group <span className="text-danger">*</span></span>
                <select value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2 py-2 text-sm text-white focus:border-brand focus:outline-none">
                  <option value="">— Select a group —</option>
                  {(groupsQ.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}{g.access?.governs ? (g.access.all ? ' · full access' : ` · ${g.access.modules.length} modules`) : ' · no access policy'}</option>)}
                </select>
              </label>
              <p className="mt-1.5 text-2xs text-muted">Determines which modules, widgets &amp; pages this user can see (Settings → Groups → Access policy).
                {(groupsQ.data ?? []).length === 0 && <span className="mt-1 block text-amber-300">No groups exist yet — create one in the Groups tab first.</span>}
                {f.role === 'admin' && <span className="mt-1 block text-muted-light">Administrators always have full access regardless of group.</span>}
              </p>
            </div>
          )}

          <Field
            label={isEdit ? 'New Password (leave blank to keep)' : 'Password'}
            value={f.password}
            onChange={(v) => setF({ ...f, password: v })}
            type="password"
            className="col-span-2"
          />

          <label className="col-span-2 block">
            <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Monitor Groups <span className="normal-case text-muted-light">(comma-separated · blank = all)</span></span>
            <input
              value={f.monitorGroups}
              onChange={(e) => setF({ ...f, monitorGroups: e.target.value })}
              placeholder="e.g. datacenter-a, cloud-prod"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none"
            />
            <span className="mt-1 block text-2xs text-muted">Restricts which IP/Host monitors this user can see. For a monitoring-only user, set role <b className="text-white">Viewer</b>, list their group(s) here, and hide other modules under <b className="text-white">Workspace → Modules</b>.</span>
          </label>

          {/* Admin-set MFA requirement — user is forced to enrol on next sign-in. */}
          <label className="col-span-2 flex items-start gap-2 rounded-lg border border-border bg-card/40 px-3 py-2">
            <input type="checkbox" checked={f.require2fa} onChange={(e) => setF({ ...f, require2fa: e.target.checked })} className="mt-0.5 h-4 w-4 accent-brand" />
            <span>
              <span className="block text-xs font-medium text-white">Require multi-factor authentication (MFA){user?.twoFactorEnabled ? ' — already enrolled ✓' : ''}</span>
              <span className="block text-2xs text-muted">When on, this user must set up an authenticator app on their next sign-in before they can use MCMF. After enrolment they can also receive a one-time code by email at sign-in.</span>
            </span>
          </label>
        </div>

        {/* Live permission preview for the chosen role */}
        {roles.find((r) => r.role === f.role) && (
          <div className="rounded-lg border border-border bg-card/60 p-3 text-2xs text-muted-light">
            <span className="font-medium text-white">{roles.find((r) => r.role === f.role)!.label}</span> — {roles.find((r) => r.role === f.role)!.description}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={save} disabled={busy || (!isEdit && !f.groupId)} title={!isEdit && !f.groupId ? 'Select an access group first' : ''} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  className = '',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  className?: string;
}) {
  const cls = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none';
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {type === 'password' ? (
        <PasswordInput value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" className={cls} />
      ) : (
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className={cls} />
      )}
    </label>
  );
}
