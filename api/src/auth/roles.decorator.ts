import { SetMetadata } from '@nestjs/common';

export type AppRole = 'admin' | 'operator' | 'viewer';
export const ROLES_KEY = 'roles';

/** Restrict a route/controller to specific roles. Overrides the default RBAC matrix. */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
