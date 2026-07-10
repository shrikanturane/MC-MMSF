import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_MODULE_KEY } from './require-module.decorator';
import { resolveAccess } from './access';

/**
 * Enforces @RequireModule(...) at the API layer (defense in depth for the UI gate). Only routes/
 * controllers carrying the decorator are checked; everything else passes untouched. admin and
 * full-access users always pass — so this can ONLY further restrict a governed group's members.
 */
@Injectable()
export class ModuleAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string>(REQUIRE_MODULE_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required) return true; // not module-gated
    const user = ctx.switchToHttp().getRequest()?.user;
    if (!user) return true; // unauthenticated/public is handled by AuthGuard
    if (user.role === 'admin') return true;
    const access = await resolveAccess(this.prisma, user.sub, user.role);
    if (access.full || access.modules.includes(required)) return true;
    throw new ForbiddenException(`Your group does not grant access to the "${required}" module.`);
  }
}
