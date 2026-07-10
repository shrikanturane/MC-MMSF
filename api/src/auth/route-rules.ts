import type { AppRole } from './roles.decorator';

/**
 * Fine-grained, declarative per-route authorization. Checked before the coarse
 * default matrix; first match wins. Paths include the global '/api' prefix.
 * Add a rule here to tighten or relax a specific endpoint without touching code.
 */
export const ROUTE_RULES: { methods: string[]; pattern: RegExp; roles: AppRole[]; reason: string }[] = [
  // Removing a cloud connection is destructive — admins only (operators may add/test/sync/edit).
  { methods: ['DELETE'], pattern: /\/connections\/[^/]+$/, roles: ['admin'], reason: 'deleting a cloud connection requires admin' },
  // Power-control of real VMs (start/stop/reboot) — operator or admin (not viewer).
  { methods: ['POST'], pattern: /\/inventory\/resources\/[^/]+\/action$/, roles: ['admin', 'operator'], reason: 'VM power control requires operator or admin' },
  // Deleting an IP/host monitor — operator or admin.
  { methods: ['DELETE'], pattern: /\/monitors\/[^/]+$/, roles: ['admin', 'operator'], reason: 'removing a monitor requires operator or admin' },
  // Creating a monitor — operator or admin (viewers are read-only). /monitors/check stays open.
  { methods: ['POST'], pattern: /\/monitors$/, roles: ['admin', 'operator'], reason: 'creating a monitor requires operator or admin' },
  // Editing a monitor — operator or admin.
  { methods: ['PATCH'], pattern: /\/monitors\/[^/]+$/, roles: ['admin', 'operator'], reason: 'editing a monitor requires operator or admin' },
];

export function matchRouteRule(method: string, path: string) {
  return ROUTE_RULES.find((r) => r.methods.includes(method) && r.pattern.test(path));
}
