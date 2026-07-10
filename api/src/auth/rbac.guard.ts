import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY, type AppRole } from './roles.decorator';
import { matchRouteRule } from './route-rules';
import type { JwtPayload } from './jwt';

/**
 * Authorization, in order of precedence:
 *   1. @Public            → skip
 *   2. /auth/*            → any authenticated role (self-account actions)
 *   3. @Roles(...)        → explicit per-route override
 *   4. ROUTE_RULES        → declarative fine-grained rules (e.g. DELETE connection = admin)
 *   5. Default matrix     → /users & /audit = admin; /settings writes = admin;
 *                           any other mutation blocks viewer; GET = any authed role
 * Runs AFTER AuthGuard, so req.user is always set.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const user: JwtPayload | undefined = req.user;
    if (!user) throw new ForbiddenException('no identity');
    const role = user.role as AppRole;
    const path: string = (req.path || req.url || '').split('?')[0];
    const method: string = (req.method || 'GET').toUpperCase();
    const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

    // 2. Self-account actions (me, change own password, logout, list/revoke own sessions).
    if (/\/auth(\/|$)/.test(path)) return true;

    // 3. Explicit @Roles(...) override.
    const required = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (required?.length) {
      if (!required.includes(role)) throw new ForbiddenException(`requires role: ${required.join(' or ')}`);
      return true;
    }

    // 4. Declarative fine-grained route rules.
    const rule = matchRouteRule(method, path);
    if (rule) {
      if (!rule.roles.includes(role)) throw new ForbiddenException(rule.reason);
      return true;
    }

    // 5. Default matrix.
    if (/\/users(\/|$)/.test(path) || /\/audit(\/|$)/.test(path)) {
      if (role !== 'admin') throw new ForbiddenException('administrator role required');
      return true;
    }
    if (/\/settings(\/|$)/.test(path) && isWrite) {
      if (role !== 'admin') throw new ForbiddenException('administrator role required to change settings');
      return true;
    }
    if (isWrite && role === 'viewer') {
      throw new ForbiddenException('viewer role is read-only');
    }
    return true;
  }
}
