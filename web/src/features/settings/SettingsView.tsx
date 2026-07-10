'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge, Card, ErrorState, LoadingState } from '@/components/ui';
import { useSettings, useUpdateSettings, useUploadAsset } from '@/lib/hooks';
import { applyAppearance } from '@/lib/branding';
import { useTabParam } from '@/lib/useTabParam';
import { THEMES, getTheme, FONT_SCALES, FONT_FAMILIES, getFontStack } from '@/lib/themes';
import { PROVIDER_COLORS, PROVIDER_LABELS, STATUS_COLORS } from '@/lib/format';
import { allTimezones, browserTz, formatClock, formatLongDate, tzCity, tzLabel, tzOffset, useClock } from '@/lib/time';
import { UsersPanel } from './UsersPanel';
import { NetworkAccessPanel } from './NetworkAccessPanel';
import { DatabasePanel } from './DatabasePanel';
import { TwoFactorCard, SessionsPanel, AuditLogPanel, ChangePasswordCard } from './AccountSecurity';
import { isModuleOn, orderedModules, widgetAllowedInModule, BOARD_MODULES, type LayoutConfig } from '@/lib/modules';
import { WIDGET_CATALOG } from '@/features/board/widgets';
import { IntegrationsCard, DeliveryLogCard } from './IntegrationsPanel';
import { ApiKeysCard } from './ApiKeysCard';
import { TlsPanel } from './TlsPanel';
import { DomainsPanel } from './DomainsPanel';
import { PlatformDomainCard } from './PlatformDomainCard';
import { AdvancedCloudIntegration } from './AdvancedCloudIntegration';
import { SystemParametersPanel } from './SystemParametersPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { MakerCheckerPanel } from './MakerCheckerPanel';
import { CredentialVault } from './CredentialVault';
import { ConnectionsView } from '@/features/connections/ConnectionsView';
import { useAuthUser } from '@/lib/auth';
import type { SettingsData } from '@/lib/types';

const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D MMM YYYY'];
const CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'AUD', 'SGD', 'JPY', 'AED'];
const LANGUAGES = ['English', 'Hindi', 'Spanish', 'French', 'German', 'Japanese'];

const INTEGRATION_ICONS: Record<string, string> = { slack: '💬', pagerduty: '📟', webhook: '🔗' };

type TabId = 'profile' | 'appearance' | 'workspace' | 'connections' | 'access' | 'vault' | 'integrations' | 'database';

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
  desc: string;
  adminOnly?: boolean;
}

const TABS: TabDef[] = [
  { id: 'profile', label: 'Profile & Security', icon: '👤', desc: 'Identity, 2FA, sessions' },
  { id: 'appearance', label: 'Appearance', icon: '🎨', desc: 'Theme, accent, text size, font, background & logo' },
  { id: 'workspace', label: 'Workspace', icon: '🧩', desc: 'Modules visible in navigation' },
  { id: 'connections', label: 'Cloud Connections', icon: '☁️', desc: 'Linked AWS, Azure & GCP accounts' },
  { id: 'access', label: 'Users & Access', icon: '👥', desc: 'Users, roles & groups (RBAC)' },
  { id: 'vault', label: 'Credential Vault', icon: '🔐', desc: 'Your encrypted device passwords (2FA to reveal)' },
  { id: 'integrations', label: 'Integrations & Audit', icon: '🔌', desc: 'Delivery channels, audit trail', adminOnly: true },
  { id: 'database', label: 'Database', icon: '🗄️', desc: 'Status, backups, replication & log retention', adminOnly: true },
];

export function SettingsView() {
  const { data, isLoading, isError } = useSettings();
  const { data: me } = useAuthUser();
  const isAdmin = me?.role === 'admin';
  const [tab, setTab] = useState<TabId>('profile');

  // Sync the active tab to the URL hash so it survives reloads and is deep-linkable.
  useEffect(() => {
    const h = window.location.hash.replace('#', '') as TabId;
    if (TABS.some((t) => t.id === h)) setTab(h);
  }, []);
  const go = (id: TabId) => {
    setTab(id);
    window.history.replaceState(null, '', `#${id}`);
  };

  if (isLoading || !data) return <LoadingState rows={6} />;
  if (isError) return <ErrorState />;

  const visible = TABS.filter((t) => !t.adminOnly || isAdmin);
  const active = visible.find((t) => t.id === tab) ?? visible[0];

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Left rail — vertical on desktop, horizontal scroller on mobile */}
      <nav className="flex shrink-0 gap-1.5 overflow-x-auto pb-1 lg:w-56 lg:flex-col lg:overflow-visible lg:pb-0">
        {visible.map((t) => {
          const on = t.id === active.id;
          return (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              className={`flex shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition lg:w-full ${
                on ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card/40 text-muted hover:text-white'
              }`}
            >
              <span className="text-base">{t.icon}</span>
              <span className="min-w-0">
                <span className="block whitespace-nowrap text-xs font-semibold">{t.label}</span>
                <span className="hidden text-2xs text-muted lg:block">{t.desc}</span>
              </span>
            </button>
          );
        })}
      </nav>

      {/* Active panel */}
      <div className="min-w-0 flex-1">
        <div className="grid grid-cols-12 gap-4">
          {active.id === 'profile' && (
            <>
              <SettingsSection title="Profile" subtitle="Your identity and regional preferences" />
              <ProfileSection settings={data} />
              <TimeLocationSection settings={data} />
              <SettingsSection title="Security" subtitle="Two-factor authentication, password and active sessions" />
              <TwoFactorCard />
              <ChangePasswordCard />
              <SessionsPanel />
            </>
          )}
          {active.id === 'appearance' && <BrandingSection settings={data} />}
          {active.id === 'workspace' && <WorkspaceCustomization settings={data} />}
          {active.id === 'connections' && <div className="col-span-12"><ConnectionsView /></div>}
          {active.id === 'access' && (
            <>
              <SettingsSection title="Users & Roles" subtitle="Accounts, roles and group membership (RBAC)" />
              <UsersPanel />
              {isAdmin && (
                <>
                  <SettingsSection title="Network Access Control" subtitle="Block access by IP, subnet or country" />
                  <NetworkAccessPanel />
                </>
              )}
            </>
          )}
          {active.id === 'vault' && <CredentialVault />}
          {active.id === 'integrations' && isAdmin && <IntegrationsAdmin />}
          {active.id === 'database' && isAdmin && <DatabasePanel />}
        </div>
      </div>
    </div>
  );
}

function SaveBtn({ onClick, pending, saved }: { onClick: () => void; pending: boolean; saved: boolean }) {
  return (
    <button onClick={onClick} disabled={pending} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">
      {pending ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
    </button>
  );
}

/** Full-width section header that groups the cards below it (Profile / Security / Appearance). */
function SettingsSection({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="col-span-12 mt-3 border-t border-border pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {subtitle && <p className="mt-0.5 text-2xs text-muted">{subtitle}</p>}
    </div>
  );
}

function ProfileSection({ settings }: { settings: SettingsData }) {
  const update = useUpdateSettings();
  const [f, setF] = useState(settings.profile);
  useEffect(() => setF(settings.profile), [settings]);
  const save = () => update.mutate({ userName: f.userName, userRole: f.userRole, userEmail: f.userEmail, orgName: f.orgName });
  return (
    <Card title="My Profile" className="col-span-12 lg:col-span-6" action={<SaveBtn onClick={save} pending={update.isPending} saved={update.isSuccess} />}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Full Name" value={f.userName} onChange={(v) => setF({ ...f, userName: v })} />
        <Field label="Role / Title" value={f.userRole} onChange={(v) => setF({ ...f, userRole: v })} />
        <Field label="Email" value={f.userEmail} onChange={(v) => setF({ ...f, userEmail: v })} className="col-span-2" />
        <Field label="Organization" value={f.orgName} onChange={(v) => setF({ ...f, orgName: v })} className="col-span-2" />
      </div>
    </Card>
  );
}

function TimeLocationSection({ settings }: { settings: SettingsData }) {
  const update = useUpdateSettings();
  const [region, setRegion] = useState(settings.region);
  useEffect(() => setRegion(settings.region), [settings]);
  const save = () => update.mutate({ timezone: region.timezone, dateFormat: region.dateFormat, currency: region.currency, language: region.language });
  return (
    <Card title="Time & Location" className="col-span-12 lg:col-span-6" action={<SaveBtn onClick={save} pending={update.isPending} saved={update.isSuccess} />}>
      <TimeRegion region={region} onChange={setRegion} />
    </Card>
  );
}

function BrandingSection({ settings }: { settings: SettingsData }) {
  const update = useUpdateSettings();
  const upload = useUploadAsset();
  const init = () => ({ orgName: settings.branding.orgName, tagline: settings.branding.tagline ?? 'Multi-Cloud Platform', primaryColor: settings.branding.primaryColor, theme: settings.branding.theme ?? 'midnight', logo: settings.branding.logo ?? '', bgImage: settings.branding.bgImage ?? '', fontScale: settings.branding.fontScale ?? 'base', fontFamily: settings.branding.fontFamily ?? 'system', reduceMotion: settings.branding.reduceMotion ?? false, highContrast: settings.branding.highContrast ?? false, solidSurfaces: settings.branding.solidSurfaces ?? false });
  const [f, setF] = useState(init);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'logo' | 'bg' | null>(null);
  useEffect(() => setF(init()), [settings]);

  // Live preview: re-apply the whole appearance (theme/accent/bg + text size/font/a11y) on any change.
  const applyPreview = (s: typeof f) => applyAppearance(s.theme, s.primaryColor, s.bgImage, { fontScale: s.fontScale, fontFamily: s.fontFamily, reduceMotion: s.reduceMotion, highContrast: s.highContrast, solidSurfaces: s.solidSurfaces });
  const patch = (p: Partial<typeof f>) => setF((cur) => { const next = { ...cur, ...p }; applyPreview(next); return next; });
  const pickTheme = (id: string) => patch({ theme: id, primaryColor: getTheme(id).accent });
  const pickAccent = (c: string) => patch({ primaryColor: c });

  const uploadImage = (kind: 'logo' | 'bg', file?: File) => {
    setErr(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) return setErr('Please choose an image file.');
    if (file.size > 5 * 1024 * 1024) return setErr('Image must be under 5 MB.');
    setBusy(kind);
    const r = new FileReader();
    r.onload = async () => {
      try {
        const { url } = await upload.mutateAsync({ data: String(r.result), mime: file.type });
        if (kind === 'logo') setF((p) => ({ ...p, logo: url }));
        else patch({ bgImage: url });
      } catch (e) { setErr((e as Error).message); }
      finally { setBusy(null); }
    };
    r.readAsDataURL(file);
  };
  const clearBg = () => patch({ bgImage: '' });
  const mode = getTheme(f.theme).mode;
  const setMode = (m: 'dark' | 'light') => { if (m === mode) return; pickTheme(m === 'light' ? 'daylight' : 'midnight'); };
  const save = () => update.mutate({ orgName: f.orgName, tagline: f.tagline, primaryColor: f.primaryColor, theme: f.theme, logo: f.logo, bgImage: f.bgImage, fontScale: f.fontScale, fontFamily: f.fontFamily, reduceMotion: f.reduceMotion, highContrast: f.highContrast, solidSurfaces: f.solidSurfaces });

  return (
    <Card title="Appearance" className="col-span-12" action={<SaveBtn onClick={save} pending={update.isPending} saved={update.isSuccess} />}>
      <div className="space-y-4">
        {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-2xs text-danger">{err}</div>}

        {/* Day / Night mode */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted">Mode</span>
          <div className="inline-flex rounded-lg border border-border bg-bg p-0.5">
            <button onClick={() => setMode('dark')} className={`rounded-md px-3 py-1 text-2xs font-medium transition ${mode === 'dark' ? 'bg-brand text-white' : 'text-muted hover:text-white'}`}>🌙 Night</button>
            <button onClick={() => setMode('light')} className={`rounded-md px-3 py-1 text-2xs font-medium transition ${mode === 'light' ? 'bg-brand text-white' : 'text-muted hover:text-white'}`}>☀️ Day</button>
          </div>
          <span className="text-2xs text-muted">switches between dark and light themes</span>
        </div>

        {/* Theme picker — live preview on click */}
        <div>
          <div className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted">Theme — background &amp; surfaces</div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {THEMES.map((t) => {
              const on = f.theme === t.id;
              return (
                <button key={t.id} onClick={() => pickTheme(t.id)} className={`overflow-hidden rounded-xl border text-left transition ${on ? 'border-brand ring-1 ring-brand' : 'border-border hover:border-muted'}`}>
                  <div className="flex h-14 items-stretch" style={{ background: t.vars.bg }}>
                    <div className="m-2 flex-1 rounded-md" style={{ background: t.vars.card, border: `1px solid ${t.vars.border}` }} />
                    <div className="m-2 ml-0 h-auto w-2.5 rounded-full" style={{ background: t.accent }} />
                  </div>
                  <div className="flex items-center justify-between px-2.5 py-1.5">
                    <span className="text-2xs font-medium text-white">{t.name}</span>
                    {on && <span className="text-2xs text-brand">●</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Accent */}
          <div>
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Accent color</div>
            <div className="flex flex-wrap items-center gap-2">
              {['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#fb923c'].map((c) => (
                <button key={c} onClick={() => pickAccent(c)} className={`h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-card transition ${f.primaryColor.toLowerCase() === c ? 'ring-white' : 'ring-transparent'}`} style={{ background: c }} />
              ))}
              <input type="color" value={f.primaryColor} onChange={(e) => pickAccent(e.target.value)} className="h-7 w-7 cursor-pointer rounded-full border-0 bg-transparent" title="Custom accent" />
            </div>
          </div>

          {/* Platform name + logo */}
          <div className="space-y-3">
            <Field label="Platform name (sidebar title)" value={f.orgName} onChange={(v) => setF({ ...f, orgName: v })} />
            <Field label="Tagline (sidebar subtitle)" value={f.tagline} onChange={(v) => setF({ ...f, tagline: v })} />
            <div>
              <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Logo (replaces the app mark) · up to 5 MB</div>
              <div className="flex items-center gap-3">
                {f.logo ? <img src={f.logo} alt="logo" className="h-10 w-10 rounded-md object-cover" /> : <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand text-sm font-bold text-white">{f.orgName.slice(0, 1).toUpperCase()}</div>}
                <input type="file" accept="image/*" onChange={(e) => uploadImage('logo', e.target.files?.[0])} className="text-2xs text-muted-light file:mr-2 file:rounded-md file:border-0 file:bg-card file:px-2 file:py-1 file:text-2xs file:text-brand" />
                {busy === 'logo' && <span className="text-2xs text-muted">uploading…</span>}
                {f.logo && <button onClick={() => setF({ ...f, logo: '' })} className="text-2xs text-danger hover:underline">remove</button>}
              </div>
            </div>
          </div>
        </div>

        {/* Background image */}
        <div>
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Background image (optional) · up to 5 MB</div>
          <div className="flex items-center gap-3">
            {f.bgImage ? <img src={f.bgImage} alt="background" className="h-12 w-20 rounded-md object-cover" /> : <div className="flex h-12 w-20 items-center justify-center rounded-md border border-border bg-bg text-2xs text-muted">none</div>}
            <input type="file" accept="image/*" onChange={(e) => uploadImage('bg', e.target.files?.[0])} className="text-2xs text-muted-light file:mr-2 file:rounded-md file:border-0 file:bg-card file:px-2 file:py-1 file:text-2xs file:text-brand" />
            {busy === 'bg' && <span className="text-2xs text-muted">uploading…</span>}
            {f.bgImage && <button onClick={clearBg} className="text-2xs text-danger hover:underline">remove</button>}
          </div>
          <div className="mt-1 text-2xs text-muted">A theme-tinted overlay is applied automatically so cards stay readable over the photo.</div>
        </div>

        {/* Text size + Font */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Text size</div>
            <div className="inline-flex rounded-lg border border-border bg-bg p-0.5">
              {FONT_SCALES.map((s) => (
                <button key={s.id} onClick={() => patch({ fontScale: s.id })} className={`rounded-md px-2.5 py-1 text-2xs font-medium transition ${f.fontScale === s.id ? 'bg-brand text-white' : 'text-muted hover:text-white'}`}>{s.name}</button>
              ))}
            </div>
            <div className="mt-1 text-2xs text-muted">Scales the whole interface proportionally. Previews live.</div>
          </div>
          <div>
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Font</div>
            <select value={f.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value })} className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-white outline-none focus:border-brand">
              {FONT_FAMILIES.map((ff) => <option key={ff.id} value={ff.id}>{ff.name}</option>)}
            </select>
            <div className="mt-1 truncate text-2xs text-muted" style={{ fontFamily: getFontStack(f.fontFamily) }}>The quick brown fox jumps over the lazy dog — 1234567890</div>
          </div>
        </div>

        {/* Advanced */}
        <div>
          <div className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted">Advanced</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {([
              { k: 'reduceMotion', label: 'Reduce motion', hint: 'disable animations & transitions' },
              { k: 'highContrast', label: 'High contrast', hint: 'stronger borders & brighter text' },
              { k: 'solidSurfaces', label: 'Solid panels', hint: 'no translucency / blur — faster' },
            ] as const).map((o) => {
              const on = !!f[o.k];
              return (
                <button key={o.k} onClick={() => patch({ [o.k]: !on } as Partial<typeof f>)} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition ${on ? 'border-brand bg-brand/10' : 'border-border hover:border-muted'}`}>
                  <span className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition ${on ? 'bg-brand' : 'bg-border'}`}><span className={`h-3 w-3 rounded-full bg-white transition ${on ? 'translate-x-3' : ''}`} /></span>
                  <span><span className="block text-2xs font-medium text-white">{o.label}</span><span className="block text-2xs text-muted">{o.hint}</span></span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="text-2xs text-muted">Appearance re-colors the entire platform — background, panels, cards, borders, accent, text size &amp; font. Changes preview instantly; click <b className="text-white">Save</b> to apply for everyone in your org.</div>
      </div>
    </Card>
  );
}

const ALL_MODULES: string[] = BOARD_MODULES.map((m) => m.id);
// Toggle one board-module for a widget. Stored value = modules ALLOWED; when all are allowed,
// drop the key (unset = addable everywhere).
function toggleModule(map: Record<string, string[]> | undefined, key: string, mod: string): Record<string, string[]> {
  const next = { ...(map ?? {}) };
  const current = next[key] ?? ALL_MODULES;
  const updated = current.includes(mod) ? current.filter((m) => m !== mod) : [...current, mod];
  if (ALL_MODULES.every((m) => updated.includes(m))) delete next[key];
  else next[key] = ALL_MODULES.filter((m) => updated.includes(m));
  return next;
}

/** Which dashboard modules a widget may be added to (admin-controlled, central). */
function ModuleChips({ allowed, onToggle }: { allowed: string[] | undefined; onToggle: (m: string) => void }) {
  return (
    <span className="flex shrink-0 flex-wrap gap-1">
      {BOARD_MODULES.map((m) => {
        const on = widgetAllowedInModule(allowed, m.id);
        return (
          <button key={m.id} onClick={() => onToggle(m.id)} title={on ? `Addable in ${m.label} — click to disallow` : `Not addable in ${m.label} — click to allow`} className={`rounded px-1.5 py-0.5 text-2xs font-medium transition ${on ? 'bg-success/15 text-success' : 'bg-border/60 text-muted line-through'}`}>
            {m.label}
          </button>
        );
      })}
    </span>
  );
}

/** Create / rename / delete custom dashboard pages (rendered as tabs under the Custom Dashboard). */
function CustomPagesEditor({ pages, onChange }: { pages: { id: string; label: string; icon?: string }[]; onChange: (p: { id: string; label: string; icon?: string }[]) => void }) {
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState('📋');
  const add = () => {
    const name = label.trim();
    if (!name) return;
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)}-${Math.random().toString(36).slice(2, 6)}`;
    onChange([...pages, { id, label: name, icon: icon.trim() || '📋' }]);
    setLabel(''); setIcon('📋');
  };
  return (
    <div className="space-y-3">
      <div className="text-2xs text-muted">Custom pages appear as tabs on the <b className="text-white">Custom Dashboard</b> (/custom). Each is an independent board you fill with widgets. Remember to click <b className="text-white">Save</b>.</div>
      <div className="flex flex-wrap items-end gap-2">
        <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="📋" className="w-16 rounded-lg border border-border bg-bg px-2 py-1.5 text-center text-sm text-white focus:border-brand focus:outline-none" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="New page name (e.g. NOC, Exec Summary)" className="flex-1 min-w-[200px] rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        <button onClick={add} disabled={!label.trim()} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">+ Add page</button>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card-hover/40 px-3 py-2 text-xs text-muted"><span>🏠</span><span className="flex-1">My Board</span><span className="rounded border border-border px-1.5 py-0.5 text-2xs">default</span></div>
        {pages.map((p, i) => (
          <div key={p.id} className="flex items-center gap-2 rounded-lg border border-border bg-card-hover/40 px-3 py-2 text-xs">
            <input value={p.icon ?? '📋'} onChange={(e) => onChange(pages.map((x, j) => (j === i ? { ...x, icon: e.target.value } : x)))} className="w-10 rounded border border-border bg-bg px-1 py-0.5 text-center text-white focus:border-brand focus:outline-none" />
            <input value={p.label} onChange={(e) => onChange(pages.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-0.5 text-white focus:border-brand focus:outline-none" />
            <button onClick={() => onChange(pages.filter((_, j) => j !== i))} className="shrink-0 text-danger hover:underline" title="Delete page">✕ delete</button>
          </div>
        ))}
        {pages.length === 0 && <div className="px-3 py-4 text-center text-2xs text-muted">No custom pages yet — add one above.</div>}
      </div>
    </div>
  );
}

type WsTab = 'modules' | 'widgets' | 'pages';
const WS_TABS: { id: WsTab; label: string }[] = [
  { id: 'modules', label: 'Modules' },
  { id: 'widgets', label: 'Dashboard Widgets' },
  { id: 'pages', label: 'Custom Pages' },
];

function WorkspaceCustomization({ settings }: { settings: SettingsData }) {
  const update = useUpdateSettings();
  const [mods, setMods] = useState<Record<string, boolean>>(settings.modules ?? {});
  const [layout, setLayout] = useState<LayoutConfig>(settings.layout ?? {});
  const [sub, setSub] = useTabParam<WsTab>('wstab', 'modules', ['modules', 'widgets', 'pages']);
  useEffect(() => {
    setMods(settings.modules ?? {});
    setLayout(settings.layout ?? {});
  }, [settings]);

  // Always send the COMPLETE layout — the backend replaces the whole JSON column.
  const save = () => update.mutate({ modules: mods, layout });

  const ordered = orderedModules(layout.moduleOrder);
  const move = (key: string, dir: -1 | 1) => {
    const keys = ordered.map((m) => m.key);
    const i = keys.indexOf(key);
    const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    setLayout({ ...layout, moduleOrder: keys });
  };

  return (
    <Card
      title="Workspace Customization"
      className="col-span-12"
      action={<SaveBtn onClick={save} pending={update.isPending} saved={update.isSuccess} />}
    >
      {/* Sub-tabs keep the (long) editors to one screenful each */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {WS_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
              sub === t.id ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mb-3 rounded-lg border border-brand/20 bg-brand/[0.04] px-3 py-2 text-2xs text-muted">
        Set module <b className="text-white">order</b>, which modules are globally enabled, where each widget can be placed, and your custom pages here. <b className="text-white">Who can see what</b> is now controlled per group in <b className="text-white">Users &amp; Access → Groups → Access policy</b>.
      </div>

      {sub === 'modules' && (
        <div className="space-y-2">
          {ordered.map((m, idx) => {
            const on = isModuleOn(m, mods);
            return (
              <div
                key={m.key}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                  on ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card-hover/40 text-muted'
                }`}
              >
                {/* Reorder */}
                <span className="flex shrink-0 flex-col leading-none">
                  <button onClick={() => move(m.key, -1)} disabled={idx === 0} className="text-muted hover:text-white disabled:opacity-25" title="Move up">▲</button>
                  <button onClick={() => move(m.key, 1)} disabled={idx === ordered.length - 1} className="text-muted hover:text-white disabled:opacity-25" title="Move down">▼</button>
                </span>
                <span className="w-4 shrink-0 text-center opacity-80">{m.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.label}</span>
                  <Link href={m.href} className="block truncate text-2xs text-brand hover:underline">{m.href}</Link>
                </span>
                {m.locked ? (
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-2xs text-muted" title="Always available">🔒</span>
                ) : (
                  <button
                    onClick={() => setMods({ ...mods, [m.key]: !on })}
                    aria-label={`Toggle ${m.label}`}
                    className={`relative h-4 w-7 shrink-0 rounded-full transition ${on ? 'bg-brand' : 'bg-border'}`}
                  >
                    <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? 'left-3.5' : 'left-0.5'}`} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {sub === 'widgets' && (
        <div className="space-y-2">
          <div className="text-2xs text-muted">Set which <b className="text-white">modules</b> (Management / Monitoring / Custom) each widget can be added to. All green = placeable everywhere. <b className="text-white">Who can add it</b> is set per group in Users &amp; Access → Groups.</div>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {WIDGET_CATALOG.map((w) => (
              <div key={w.kind} className="rounded-lg border border-border bg-card-hover/40 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <span className="block truncate font-medium text-white">{w.label}</span>
                  <span className="block truncate text-2xs text-muted">{w.desc}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 border-t border-border-soft pt-1.5">
                  <span className="shrink-0 text-2xs text-muted">Modules:</span>
                  <ModuleChips allowed={layout.widgetModules?.[w.kind]} onToggle={(m) => setLayout({ ...layout, widgetModules: toggleModule(layout.widgetModules, w.kind, m) })} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {sub === 'pages' && <CustomPagesEditor pages={layout.customPages ?? []} onChange={(p) => setLayout({ ...layout, customPages: p })} />}
    </Card>
  );
}

const INT_TABS = [
  { id: 'system', label: 'System' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'tls', label: 'TLS & Domains' },
  { id: 'audit', label: 'Audit & Logs' },
] as const;

function IntegrationsAdmin() {
  const { data: me } = useAuthUser();
  const [sub, setSub] = useTabParam<string>('inttab', 'system', ['system', 'integrations', 'tls', 'audit']);
  if (me?.role !== 'admin') return null;
  return (
    <>
      <div className="col-span-12 flex flex-wrap gap-1.5">
        {INT_TABS.map((t) => (
          <button key={t.id} onClick={() => setSub(t.id)} className={`rounded-lg border px-3 py-1.5 text-xs transition ${sub === t.id ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted hover:text-white'}`}>{t.label}</button>
        ))}
      </div>

      {sub === 'system' && (
        <>
          <SettingsSection title="System Parameters" subtitle="Operator-tunable runtime parameters (intervals, retention, expiry) — change without a redeploy" />
          <SystemParametersPanel />
          <SettingsSection title="Environment & Secrets" subtitle="Deploy-time config for admin visibility — infra shown plainly, secrets revealed with a 2FA code" />
          <EnvironmentPanel />
          <SettingsSection title="Approval Process — Maker-Checker" subtitle="Segregation of duties for approvals — enabling is open; disabling requires a 2FA code" />
          <MakerCheckerPanel />
          <SettingsSection title="Advanced Cloud Integration" subtitle="Enable or disable live create of VMs / networks / disks" />
          <AdvancedCloudIntegration />
        </>
      )}

      {sub === 'integrations' && (
        <>
          <SettingsSection title="Notification Integrations" subtitle="Email, WhatsApp & SSO — auto-tested every hour" />
          <IntegrationsCard />
          <SettingsSection title="Open API — ITSM & Monitoring tools" subtitle="API keys for 3rd-party ITSM (ServiceNow, Jira SM) & monitoring tools to pull all monitor/device/agent/alert data" />
          <ApiKeysCard />
        </>
      )}

      {sub === 'tls' && (
        <>
          <SettingsSection title="TLS, Certificates & Domains" subtitle="Set this server’s domain (Let’s Encrypt / your own cert / upstream TLS), plus advanced certificate and email (DKIM/SPF/DMARC) controls. Step-by-step DNS for GoDaddy / Microsoft 365 / Bigrock / Cloudflare in Help → §15." />
          <PlatformDomainCard />
          <TlsPanel />
          <DomainsPanel />
        </>
      )}

      {sub === 'audit' && (
        <>
          <SettingsSection title="Delivery & Audit" subtitle="Notification delivery log and the security audit trail" />
          <DeliveryLogCard />
          <AuditLogPanel />
        </>
      )}
    </>
  );
}

function TimeRegion({
  region,
  onChange,
}: {
  region: SettingsData['region'];
  onChange: (r: SettingsData['region']) => void;
}) {
  const now = useClock();
  // Offsets don't change second-to-second — build the (large) option list once.
  const zoneOptions = useMemo(() => allTimezones().map((z) => ({ z, label: tzLabel(z) })), []);
  const inList = useMemo(() => zoneOptions.some((o) => o.z === region.timezone), [zoneOptions, region.timezone]);
  const set = (patch: Partial<SettingsData['region']>) => onChange({ ...region, ...patch });

  return (
    <div className="space-y-3">
      {/* Live clock preview in the selected timezone */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-card/60 px-4 py-3">
        <div>
          <div className="font-mono text-xl font-semibold tabular-nums text-white">{formatClock(now, region.timezone)}</div>
          <div className="text-2xs text-muted">{formatLongDate(now, region.timezone)}</div>
        </div>
        <div className="text-right text-2xs">
          <div className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-white">📍 {tzCity(region.timezone)}</div>
          <div className="mt-1 text-muted">{tzOffset(now, region.timezone)}</div>
        </div>
      </div>

      <label className="block">
        <span className="mb-1.5 flex items-center justify-between text-2xs font-medium uppercase tracking-wide text-muted">
          Timezone / Location
          <button
            type="button"
            onClick={() => set({ timezone: browserTz() })}
            className="rounded border border-border bg-card px-1.5 py-0.5 text-2xs normal-case text-brand hover:text-white"
          >
            Detect mine
          </button>
        </span>
        <select
          value={region.timezone}
          onChange={(e) => set({ timezone: e.target.value })}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
        >
          {/* Ensure the current value is selectable even if not in the list */}
          {!inList && <option value={region.timezone}>{region.timezone}</option>}
          {zoneOptions.map((o) => (
            <option key={o.z} value={o.z}>{o.label}</option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <Select label="Date Format" value={region.dateFormat} options={DATE_FORMATS} onChange={(v) => set({ dateFormat: v })} />
        <Select label="Currency" value={region.currency} options={CURRENCIES} onChange={(v) => set({ currency: v })} />
        <Select label="Language" value={region.language} options={LANGUAGES} onChange={(v) => set({ language: v })} className="col-span-2" />
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
      >
        {!options.includes(value) && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
      />
    </label>
  );
}
