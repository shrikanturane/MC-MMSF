import { PrismaService } from '../prisma/prisma.service';

export interface EffectiveAccess { full: boolean; modules: string[]; widgets: string[]; help: string[]; pages: string[] }

/**
 * Resolve a user's effective group-based access. admin → full. Otherwise the UNION of every governing
 * group's policy; a non-admin in no governing group gets nothing (strict). Shared by /auth/me and the
 * ModuleAccessGuard so the UI and the API agree on exactly one source of truth.
 */
export async function resolveAccess(prisma: PrismaService, userId: string, role: string): Promise<EffectiveAccess> {
  const empty = { modules: [] as string[], widgets: [] as string[], help: [] as string[], pages: [] as string[] };
  if (role === 'admin') return { full: true, ...empty };
  const memberships = await prisma.groupMembership.findMany({ where: { userId }, include: { group: true } }).catch(() => []);
  const governing = memberships.map((m) => ((m.group as any).access as any) || {}).filter((a) => a && a.governs);
  if (governing.length === 0) return { full: false, ...empty };
  if (governing.some((a) => a.all)) return { full: true, ...empty };
  const uni = (k: string) => Array.from(new Set(governing.flatMap((a) => (Array.isArray(a[k]) ? (a[k] as string[]) : []))));
  return { full: false, modules: uni('modules'), widgets: uni('widgets'), help: uni('help'), pages: uni('pages') };
}
