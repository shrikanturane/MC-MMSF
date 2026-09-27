process.env.AUTH_SECRET = 'unit-test-secret';
import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '../src/auth/auth.guard';
import { isSessionToken, signJwt } from '../src/auth/jwt';
import { clientIp } from '../src/modules/access/access-control.middleware';

const future = new Date(Date.now() + 3600_000);

function guardWith(session: any) {
  const reflector = { getAllAndOverride: () => false } as any;
  const prisma = { session: { findUnique: jest.fn().mockResolvedValue(session) } } as any;
  return new AuthGuard(reflector, prisma);
}

function ctx(token: string) {
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  return { req, ctx: { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) } as any };
}

describe('AuthGuard', () => {
  const base = { sub: 'u1', role: 'admin' as const, name: 'A', email: 'a@x.io' };

  it('accepts a live session token', async () => {
    const { req, ctx: c } = ctx(signJwt({ ...base, jti: 's1' }));
    await expect(guardWith({ id: 's1', userId: 'u1', revokedAt: null, expiresAt: future }).canActivate(c)).resolves.toBe(true);
    expect(req.user.sub).toBe('u1');
  });

  it('rejects the SSO state nonce handed to anonymous callers', async () => {
    const { ctx: c } = ctx(signJwt({ sub: 'google', role: 'viewer', name: 'sso-state', email: 'sso', scope: 'sso' }));
    await expect(guardWith(null).canActivate(c)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a 2FA challenge token', async () => {
    const { ctx: c } = ctx(signJwt({ ...base, scope: '2fa' }));
    await expect(guardWith(null).canActivate(c)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token with no session id', async () => {
    const { ctx: c } = ctx(signJwt(base));
    await expect(guardWith(null).canActivate(c)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a session that belongs to another user', async () => {
    const { ctx: c } = ctx(signJwt({ ...base, jti: 's1' }));
    await expect(guardWith({ id: 's1', userId: 'someone-else', revokedAt: null, expiresAt: future }).canActivate(c)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a revoked session', async () => {
    const { ctx: c } = ctx(signJwt({ ...base, jti: 's1' }));
    await expect(guardWith({ id: 's1', userId: 'u1', revokedAt: new Date(), expiresAt: future }).canActivate(c)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('isSessionToken requires a jti and no scope', () => {
    expect(isSessionToken({ ...base, jti: 's1' })).toBe(true);
    expect(isSessionToken({ ...base })).toBe(false);
    expect(isSessionToken({ ...base, jti: 's1', scope: 'sso' })).toBe(false);
    expect(isSessionToken(null)).toBe(false);
  });
});

describe('clientIp', () => {
  it('ignores a client-supplied X-Forwarded-For and uses the proxy-resolved req.ip', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '10.9.9.9, 203.0.113.7' }, ip: '203.0.113.7' })).toBe('203.0.113.7');
  });
});
