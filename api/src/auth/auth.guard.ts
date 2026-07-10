import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { verifyJwt } from './jwt';

/** Global gate: every route needs a valid Bearer JWT (+ live session) unless marked @Public. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyJwt(token);
    if (!payload) throw new UnauthorizedException('authentication required');
    // A 2FA pre-auth challenge is NOT a session token — it can't access protected routes.
    if (payload.scope === '2fa') throw new UnauthorizedException('two-factor verification required');

    // Session-backed tokens: reject if the session was revoked or expired.
    if (payload.jti) {
      const session = await this.prisma.session.findUnique({ where: { id: payload.jti } });
      if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException('session expired or revoked');
      }
    }
    req.user = payload;
    return true;
  }
}
