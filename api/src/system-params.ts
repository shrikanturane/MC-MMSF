/**
 * Operator-tunable runtime parameters, read from OrgSettings so they're changeable in Settings →
 * System Parameters with NO redeploy. A small in-process cache (20s) keeps per-tick loops cheap.
 * Each getter falls back to the env var, then the documented default, so nothing breaks if unset.
 */

let cache: { at: number; org: any } = { at: 0, org: null };

export async function sysParams(prisma: { orgSettings: { findUnique: (a: any) => Promise<any> } }): Promise<any> {
  if (cache.org && Date.now() - cache.at < 20_000) return cache.org;
  const org = await prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
  cache = { at: Date.now(), org };
  return org ?? {};
}

/** Invalidate the cache immediately (call after a settings update so changes apply at once). */
export function bustSysParams(): void {
  cache = { at: 0, org: null };
}

/** A positive integer param: OrgSettings value → env var → default. */
export function pInt(org: any, key: string, envKey: string | null, def: number, min = 1): number {
  const fromDb = Number(org?.[key]);
  if (Number.isFinite(fromDb) && fromDb >= min) return fromDb;
  const fromEnv = envKey ? Number(process.env[envKey]) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv >= min) return fromEnv;
  return def;
}
