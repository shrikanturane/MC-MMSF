// Single source of truth for platform modules. Both the sidebar (what renders)
// and Settings → Module Customization (what's toggleable) are built from this,
// so every toggle maps to a real route and only selected modules appear in nav.
export interface PlatformModule {
  key: string;
  label: string;
  href: string;
  icon: string;
  locked?: boolean; // always visible — can't be hidden (you can't lock yourself out)
}

export const PLATFORM_MODULES: PlatformModule[] = [
  { key: 'topology', label: 'Network Topology', href: '/topology', icon: '🗺' },
  { key: 'management', label: 'Management', href: '/', icon: '▦' },
  { key: 'dashboard', label: 'My Dashboard', href: '/custom', icon: '📊' },
  { key: 'monitoring', label: 'Monitoring', href: '/monitoring', icon: '◍' },
  { key: 'security', label: 'Security', href: '/security', icon: '🛡' },
  { key: 'governance', label: 'Governance', href: '/governance', icon: '⚖' },
  { key: 'finops', label: 'FinOps & Carbon', href: '/finops', icon: '💰' },
  { key: 'network', label: 'Network', href: '/network', icon: '🌐' },
  { key: 'inventory', label: 'Cloud Inventory', href: '/inventory', icon: '☰' },
  { key: 'catalog', label: 'Service Catalog', href: '/catalog', icon: '🧰' },
  { key: 'replication', label: 'Replication & DR', href: '/replication', icon: '⇄' },
  { key: 'commandCenter', label: 'Command Center', href: '/command-center', icon: '◎' },
  { key: 'ai', label: 'Cloud AI Engine', href: '/ai', icon: '🧠' },
  { key: 'activity', label: 'Activity', href: '/activity', icon: '📜' },
  { key: 'approvals', label: 'Approvals', href: '/approvals', icon: '🛂' },
  { key: 'reports', label: 'Reports', href: '/reports', icon: '📄' },
  { key: 'help', label: 'Help', href: '/help', icon: '❔', locked: true },
  { key: 'settings', label: 'Settings', href: '/settings', icon: '⚙', locked: true },
];

/** A module is shown when it's locked, or not explicitly toggled off. */
export const isModuleOn = (m: PlatformModule, modules: Record<string, boolean>) =>
  m.locked === true || modules[m.key] !== false;

// ── Role-based visibility & ordering ───────────────────────────────────────
// Admin always sees everything; these toggles govern what Operator / Viewer see.
export type AppRole = 'admin' | 'operator' | 'viewer';
export const MANAGED_ROLES: { key: AppRole; label: string }[] = [
  { key: 'operator', label: 'Operator' },
  { key: 'viewer', label: 'Viewer' },
];

export interface LayoutConfig {
  moduleOrder?: string[]; // ordered module keys (sidebar + settings)
  moduleRoles?: Record<string, AppRole[]>; // managed roles allowed; absent = all
  widgetRoles?: Record<string, AppRole[]>; // dashboard widget kind -> allowed roles
  widgetModules?: Record<string, string[]>; // widget kind -> board modules it may be added to (absent = all)
  helpRoles?: Record<string, AppRole[]>; // help section id -> allowed roles
  customPages?: { id: string; label: string; icon?: string }[]; // user-created dashboard pages under /custom
}

/** Dashboard modules that host an editable board (each gets its own "Add Widget" scope). */
export const BOARD_MODULES: { id: string; label: string }[] = [
  { id: 'management', label: 'Management / Home' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'custom', label: 'Custom Dashboard' },
];

/** Admin sees all. Otherwise visible when no restriction set, or role is allowed. */
export function roleCanSee(allowed: AppRole[] | undefined, role?: string): boolean {
  if (role === 'admin') return true;
  if (!allowed) return true; // unset = visible to everyone
  return allowed.includes((role ?? '') as AppRole);
}

// ── Group-based access (replaces per-role visibility) ──────────────────────
// The current user's effective access, computed server-side from their groups (see /auth/me).
export interface UserAccess { full: boolean; modules: string[]; widgets: string[]; help: string[]; pages: string[] }
/**
 * Access gate for any access-controlled item kind. admin or a "full" policy → allowed.
 * A missing access object (still loading, or a legacy token) is treated as allowed so the UI never
 * flickers-to-empty; once the real policy arrives, non-listed items are hidden.
 */
export function accessAllows(access: UserAccess | null | undefined, kind: 'modules' | 'widgets' | 'help' | 'pages', key: string, role?: string): boolean {
  if (role === 'admin') return true;
  if (!access) return true;
  if (access.full) return true;
  return (access[kind] ?? []).includes(key);
}

/** A widget is addable to a module when no per-module restriction is set, or the module is allowed. */
export function widgetAllowedInModule(allowed: string[] | undefined, module: string): boolean {
  if (!allowed || allowed.length === 0) return true; // unset = all modules
  return allowed.includes(module);
}

/** PLATFORM_MODULES sorted by the saved order; unknown/new keys keep default order at the end. */
export function orderedModules(order?: string[]): PlatformModule[] {
  if (!order || order.length === 0) return PLATFORM_MODULES;
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? 1000 : i;
  };
  return [...PLATFORM_MODULES].sort((a, b) => rank(a.key) - rank(b.key));
}

// Help page sections that can be hidden per role (ids match HelpView gates).
export const HELP_SECTIONS: { id: string; label: string }[] = [
  { id: 'platform-guide', label: 'MCMF Platform Guide (full documentation)' },
  { id: 'platform-integrations', label: 'Platform Integrations (SSO · MFA · Email · WhatsApp)' },
  { id: 'guest-agent', label: 'Guest Agent Install' },
  { id: 'grant-scripts', label: 'Grant Cloud Permission Scripts' },
  { id: 'provisioning', label: 'Remote Provisioning & Network Config' },
  { id: 'smtp', label: 'Email (SMTP) Setup' },
  { id: 'infra', label: 'Data Center & Monitoring Protocols' },
  { id: 'cloud-perms', label: 'Cloud Permissions Reference (AWS · Azure · GCP)' },
];
