'use client';

import { useBranding } from './branding';
import { useAuthUser } from './auth';
import { accessAllows, isModuleOn, orderedModules } from './modules';

/** The platform modules the current user can see — saved order, module toggles, then group access.
 *  Shared by the desktop sidebar, the mobile drawer and the mobile bottom-bar so they never drift. */
export function useNavModules() {
  const { modules, layout } = useBranding();
  const { data: user } = useAuthUser();
  const items = orderedModules(layout.moduleOrder)
    .filter((m) => isModuleOn(m, modules))
    .filter((m) => accessAllows(user?.access, 'modules', m.key, user?.role));
  const noAccess = !!(user && user.role !== 'admin' && user.access && !user.access.full && items.length === 0);
  return { items, noAccess, user };
}
