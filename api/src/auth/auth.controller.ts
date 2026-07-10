import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { ssoBaseUrl } from './sso';

function meta(req: any) {
  return {
    ip: (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.socket?.remoteAddress || '').toString() || null,
    userAgent: (req.headers['user-agent'] || '').toString() || null,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  // Brute-force protection: 10 login attempts / minute / IP (vs the 600/min global default).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @Post('login')
  login(@Body() body: { email?: string; password?: string; remember?: boolean }, @Req() req: any) {
    return this.service.login(body?.email, body?.password, meta(req), !!body?.remember);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Public()
  @Post('2fa/verify')
  verify2fa(@Body() body: { challenge?: string; code?: string; remember?: boolean }, @Req() req: any) {
    return this.service.verify2fa(body?.challenge, body?.code, meta(req), !!body?.remember);
  }

  // Email an alternative one-time code during a 2FA login challenge. Rate-limited to stop OTP spam.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Public()
  @Post('2fa/email-otp')
  emailOtp(@Body() body: { challenge?: string }) {
    return this.service.sendEmailOtp(body?.challenge);
  }

  @Get('me')
  me(@Req() req: any) {
    return this.service.me(req.user.sub, req.user.jti);
  }

  // ── 2FA enrollment (authenticated) ──
  @Post('2fa/setup')
  setup2fa(@Req() req: any) {
    return this.service.setup2fa(req.user.sub);
  }

  @Post('2fa/enable')
  enable2fa(@Body() body: { code?: string }, @Req() req: any) {
    return this.service.enable2fa(req.user.sub, body?.code, meta(req));
  }

  @Post('2fa/disable')
  disable2fa(@Body() body: { code?: string }, @Req() req: any) {
    return this.service.disable2fa(req.user.sub, body?.code, meta(req));
  }

  @Post('password')
  changePassword(@Body() body: { currentPassword?: string; newPassword?: string }, @Req() req: any) {
    return this.service.changeOwnPassword(req.user.sub, body?.currentPassword, body?.newPassword, meta(req));
  }

  @Post('logout')
  logout(@Req() req: any) {
    return this.service.logout(req.user, meta(req));
  }

  // ── Sessions ──
  @Get('sessions')
  sessions(@Req() req: any) {
    return this.service.listSessions(req.user.sub, req.user.jti);
  }

  @Delete('sessions/:id')
  revokeSession(@Param('id') id: string, @Req() req: any) {
    return this.service.revokeSession(req.user.sub, id);
  }

  // ── Forgot / reset (public) ──
  @Public()
  @Post('forgot')
  forgot(@Body() body: { email?: string }, @Req() req: any) {
    return this.service.forgotPassword(body?.email, meta(req));
  }

  @Public()
  @Post('reset')
  reset(@Body() body: { token?: string; newPassword?: string }, @Req() req: any) {
    return this.service.resetPassword(body?.token, body?.newPassword, meta(req));
  }

  // ── Forgot 2FA (public) ──
  @Public()
  @Post('2fa/forgot')
  forgot2fa(@Body() body: { email?: string }, @Req() req: any) {
    return this.service.forgot2fa(body?.email, meta(req));
  }

  @Public()
  @Post('2fa/reset-token')
  reset2faToken(@Body() body: { token?: string }, @Req() req: any) {
    return this.service.reset2faToken(body?.token, meta(req));
  }

  // ── SSO (OAuth) — public ──
  @Public()
  @Get('sso/providers')
  ssoProviders() {
    return this.service.ssoProviders();
  }

  @Public()
  @Get('sso/:provider/start')
  async ssoStart(@Param('provider') provider: string, @Res() res: Response) {
    try {
      res.redirect(await this.service.ssoStartUrl(provider));
    } catch (e) {
      res.redirect(`${ssoBaseUrl()}/?sso_error=${encodeURIComponent((e as Error).message)}`);
    }
  }

  @Public()
  @Get('sso/:provider/callback')
  async ssoCallback(@Param('provider') provider: string, @Query('code') code: string, @Query('state') state: string, @Req() req: any, @Res() res: Response) {
    try {
      const { token } = await this.service.ssoLogin(provider, code, state, meta(req));
      // Hand the token to the SPA via a short-lived one-time code, NOT in the URL (avoids leaking
      // the session token through browser history / Referer / proxy access logs).
      const handoff = await this.service.issueSsoCode(token);
      res.redirect(`${ssoBaseUrl()}/?sso_code=${handoff}`);
    } catch (e) {
      res.redirect(`${ssoBaseUrl()}/?sso_error=${encodeURIComponent((e as Error).message)}`);
    }
  }

  // SPA exchanges the one-time SSO code from the callback URL for the actual session token.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Public()
  @Post('sso/exchange')
  ssoExchange(@Body() body: { code?: string }) {
    return this.service.exchangeSsoCode(body?.code);
  }
}
