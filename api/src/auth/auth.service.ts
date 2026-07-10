import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { sendMail, emailEnabled } from '../mail/mailer';
import { sysParams, pInt } from '../system-params';
import { PrismaService } from '../prisma/prisma.service';
import { resolveAccess } from './access';
import { AuditService } from '../modules/audit/audit.service';
import { hashPassword, verifyPassword } from '../modules/users/users.service';
import { signJwt, verifyJwt } from './jwt';
import { generateRecoveryCodes, generateTotpSecret, hashRecovery, otpauthUrl, verifyTotp } from './totp';
import { authorizeUrl, exchangeAndProfile, ssoConfigured, type SsoProvider } from './sso';

interface ReqMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const TTL_DEFAULT = 60 * 60 * 12; // 12h
const TTL_REMEMBER = 60 * 60 * 24 * 30; // 30d
const RESET_TTL_MS = 1000 * 60 * 30; // 30 min

// Brute-force protection: lock an (ip,email) after MAX_FAILS within WINDOW.
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 1000 * 60 * 15; // 15 min
const LOCK_MS = 1000 * 60 * 15; // 15 min
// Per-IP spray cap: total failures from one IP across ANY account within the window.
const MAX_IP_FAILS = 20;

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');
  // In-memory brute-force tracker (single instance). Keyed by `${ip}|${email}`.
  private readonly attempts = new Map<string, { fails: number; first: number; lockedUntil: number }>();
  // Per-IP spray tracker keyed by ip.
  private readonly ipAttempts = new Map<string, { fails: number; first: number; lockedUntil: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async login(email?: string, password?: string, meta: ReqMeta = {}, remember = false) {
    const e = (email || '').trim().toLowerCase();
    const ip = meta.ip ?? 'unknown';
    const key = `${ip}|${e}`;
    const now = Date.now();

    const rec = this.attempts.get(key);
    const ipRec = this.ipAttempts.get(ip);
    if ((rec && rec.lockedUntil > now) || (ipRec && ipRec.lockedUntil > now)) {
      const until = Math.max(rec?.lockedUntil ?? 0, ipRec?.lockedUntil ?? 0);
      const mins = Math.ceil((until - now) / 60000);
      await this.audit.record({ action: 'login_failed', actorEmail: e || '(blank)', ip: meta.ip, userAgent: meta.userAgent, detail: 'locked out (too many attempts)' });
      throw new HttpException(`Too many failed attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.prisma.user.findUnique({ where: { email: e } });
    if (!user || user.status !== 'active' || !verifyPassword(password || '', user.passwordHash)) {
      // Count the failure within the rolling window (per-account + per-IP).
      const base = rec && now - rec.first < FAIL_WINDOW_MS ? rec : { fails: 0, first: now, lockedUntil: 0 };
      base.fails += 1;
      if (base.fails >= MAX_FAILS) base.lockedUntil = now + LOCK_MS;
      this.attempts.set(key, base);
      const ipBase = ipRec && now - ipRec.first < FAIL_WINDOW_MS ? ipRec : { fails: 0, first: now, lockedUntil: 0 };
      ipBase.fails += 1;
      if (ipBase.fails >= MAX_IP_FAILS) ipBase.lockedUntil = now + LOCK_MS;
      this.ipAttempts.set(ip, ipBase);
      await this.audit.record({
        action: 'login_failed',
        actorEmail: e || '(blank)',
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: `${!user ? 'no such user' : user.status !== 'active' ? 'account suspended' : 'bad password'} (${base.fails}/${MAX_FAILS})`,
      });
      throw new UnauthorizedException('invalid email or password');
    }
    // Success — clear the brute-force counter.
    this.attempts.delete(key);

    // Second factor required → hand back a short-lived challenge instead of a session.
    if (user.totpEnabled) {
      const challenge = await signJwt({ sub: user.id, role: user.role, name: user.name, email: user.email, scope: '2fa' }, 300);
      return { twoFactorRequired: true as const, challenge };
    }
    return this.issueSession(user, meta, remember);
  }

  /** Complete a 2FA login: verify the challenge + a TOTP/recovery code → real session. */
  async verify2fa(challenge?: string, code?: string, meta: ReqMeta = {}, remember = false) {
    const payload = await verifyJwt(challenge || '');
    if (!payload || payload.scope !== '2fa') throw new UnauthorizedException('invalid or expired verification challenge');
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.totpEnabled || user.status !== 'active') throw new UnauthorizedException('two-factor not available');

    const codeT = (code || '').trim();
    const okEmail = !!(user as any).emailOtpHash && !!(user as any).emailOtpExpires && new Date((user as any).emailOtpExpires) > new Date()
      && createHash('sha256').update(codeT).digest('hex') === (user as any).emailOtpHash;
    const ok = (user.totpSecret && verifyTotp(user.totpSecret, codeT)) || okEmail || (await this.consumeRecovery(user.id, codeT));
    if (!ok) {
      await this.audit.record({ action: 'login_failed', actorEmail: user.email, actorId: user.id, ip: meta.ip, userAgent: meta.userAgent, detail: 'bad 2FA code' });
      throw new UnauthorizedException('invalid two-factor code');
    }
    if (okEmail) await this.prisma.user.update({ where: { id: user.id }, data: { emailOtpHash: null, emailOtpExpires: null } as any }).catch(() => undefined);
    return this.issueSession(user, meta, remember, okEmail ? '2fa-email' : '2fa');
  }

  /** Email an alternative one-time code during a 2FA login challenge (after TOTP is enrolled). */
  async sendEmailOtp(challenge?: string) {
    const payload = await verifyJwt(challenge || '');
    if (!payload || payload.scope !== '2fa') throw new UnauthorizedException('invalid or expired verification challenge');
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.totpEnabled || user.status !== 'active') throw new UnauthorizedException('two-factor not available');
    if (!emailEnabled()) throw new BadRequestException('Email delivery is not configured — use your authenticator code.');
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await this.prisma.user.update({ where: { id: user.id }, data: { emailOtpHash: createHash('sha256').update(otp).digest('hex'), emailOtpExpires: new Date(Date.now() + 10 * 60_000) } as any });
    try {
      await sendMail({ to: user.email, subject: '[MCMF] Your sign-in code', text: `Your MCMF verification code is ${otp}\n\nIt expires in 10 minutes. If you did not try to sign in, change your password immediately.` });
    } catch (err) {
      this.log.warn(`email OTP to ${user.email} failed: ${String((err as Error)?.message ?? err)}`);
      throw new BadRequestException('Could not send the email code — use your authenticator code.');
    }
    const masked = user.email.replace(/^(.).*(@.*)$/, '$1•••$2');
    return { sent: true, to: masked };
  }

  private async issueSession(user: { id: string; role: any; name: string; email: string }, meta: ReqMeta, remember: boolean, via?: string) {
    // Normal session lifetime is operator-tunable (Settings → System Parameters → Session timeout).
    const hours = pInt(await sysParams(this.prisma), 'sessionTimeoutHours', null, 12);
    const ttl = remember ? TTL_REMEMBER : hours * 3600;
    const session = await this.prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + ttl * 1000), ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ action: 'login', actorEmail: user.email, actorId: user.id, ip: meta.ip, userAgent: meta.userAgent, detail: [remember ? 'remember-me' : '', via].filter(Boolean).join(' ') || undefined });
    const token = await signJwt({ sub: user.id, role: user.role, name: user.name, email: user.email, jti: session.id }, ttl);
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  // ── 2FA enrollment ──────────────────────────────────────────────
  async setup2fa(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('session no longer valid');
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpPending: secret } });
    return { secret, otpauthUrl: otpauthUrl(user.email, secret) };
  }

  async enable2fa(userId: string, code?: string, meta: ReqMeta = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.totpPending) throw new BadRequestException('start setup first');
    if (!verifyTotp(user.totpPending, code || '')) throw new BadRequestException('invalid code — check your authenticator and try again');
    const { plain, hashes } = generateRecoveryCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabled: true, totpSecret: user.totpPending, totpPending: null, recoveryCodes: hashes } });
    await this.audit.record({ action: 'password_changed', actorEmail: user.email, actorId: user.id, targetEmail: user.email, ip: meta.ip, userAgent: meta.userAgent, detail: '2FA enabled' });
    return { ok: true, recoveryCodes: plain };
  }

  async disable2fa(userId: string, code?: string, meta: ReqMeta = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.totpEnabled) throw new BadRequestException('2FA is not enabled');
    const ok = (user.totpSecret && verifyTotp(user.totpSecret, code || '')) || (await this.consumeRecovery(user.id, code || ''));
    if (!ok) throw new BadRequestException('invalid code');
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecret: null, totpPending: null, recoveryCodes: [] } });
    await this.audit.record({ action: 'password_changed', actorEmail: user.email, actorId: user.id, targetEmail: user.email, ip: meta.ip, userAgent: meta.userAgent, detail: '2FA disabled' });
    return { ok: true };
  }

  // ── Single Sign-On (OAuth) ──────────────────────────────────────
  ssoProviders() {
    return ssoConfigured();
  }

  /** Build the provider authorize URL with a signed state nonce (CSRF protection). */
  async ssoStartUrl(provider: string): Promise<string> {
    const p = provider as SsoProvider;
    if (!['google', 'microsoft'].includes(p)) throw new BadRequestException('unknown SSO provider');
    if (!ssoConfigured()[p === 'google' ? 'google' : 'microsoft']) throw new BadRequestException(`${p} SSO is not configured`);
    const state = await signJwt({ sub: p, role: 'viewer', name: 'sso-state', email: 'sso', scope: 'sso' }, 600);
    return authorizeUrl(p, state);
  }

  /** Handle the OAuth callback → resolve the MCMF user → issue a session token. */
  async ssoLogin(provider: string, code?: string, state?: string, meta: ReqMeta = {}) {
    const p = provider as SsoProvider;
    const payload = await verifyJwt(state || '');
    if (!payload || payload.scope !== 'sso' || payload.sub !== p) throw new UnauthorizedException('invalid SSO state');
    if (!code) throw new BadRequestException('missing authorization code');

    const profile = await exchangeAndProfile(p, code);
    if (!profile.email) throw new UnauthorizedException('SSO provider returned no email');

    let user = await this.prisma.user.findUnique({ where: { email: profile.email } });
    if (!user) {
      if (process.env.SSO_AUTO_PROVISION === '1') {
        user = await this.prisma.user.create({ data: { name: profile.name || profile.email, email: profile.email, role: 'viewer', status: 'active', passwordHash: '' } });
        await this.audit.record({ action: 'user_created', actorEmail: `sso:${p}`, targetEmail: profile.email, detail: 'auto-provisioned via SSO' });
      } else {
        throw new UnauthorizedException(`No MCMF account for ${profile.email}. Ask an admin to add you first.`);
      }
    }
    if (user.status !== 'active') throw new UnauthorizedException('account suspended');
    return this.issueSession(user, meta, false, `sso:${p}`);
  }

  private async consumeRecovery(userId: string, code: string): Promise<boolean> {
    if (!code) return false;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const codes = ((user?.recoveryCodes as string[]) ?? []).slice();
    const h = hashRecovery(code);
    const idx = codes.indexOf(h);
    if (idx < 0) return false;
    codes.splice(idx, 1); // one-time use
    await this.prisma.user.update({ where: { id: userId }, data: { recoveryCodes: codes } });
    return true;
  }

  async me(userId: string, sessionId?: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new UnauthorizedException('session no longer valid');
    if (sessionId) {
      await this.prisma.session.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    }
    // Mandatory-2FA enrolment gate: enforced only for operator & viewer roles (admins exempt for now),
    // and only while the org-level require2fa master switch is on.
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    const masterOn = (org as any)?.require2fa ?? true;
    const roleNeeds2fa = u.role === 'operator' || u.role === 'viewer';
    // Per-user MFA (admin-set) forces enrolment regardless of role; the role-based gate still honours
    // the org master switch. Either path routes the user through the existing Enforce2FA enrolment.
    const access = await resolveAccess(this.prisma, u.id, u.role);
    return { id: u.id, name: u.name, email: u.email, role: u.role, contact: u.contact, sessionId: sessionId ?? null, twoFactorEnabled: u.totpEnabled, twoFactorRequired: (u as any).require2fa || (masterOn && roleNeeds2fa), access };
  }

  async changeOwnPassword(userId: string, currentPassword?: string, newPassword?: string, meta: ReqMeta = {}) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new UnauthorizedException('session no longer valid');
    if (!verifyPassword(currentPassword || '', u.passwordHash)) throw new BadRequestException('current password is incorrect');
    if (!newPassword || newPassword.length < 10) throw new BadRequestException('new password must be at least 10 characters');
    await this.prisma.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(newPassword) } });
    await this.audit.record({ action: 'password_changed', actorEmail: u.email, actorId: u.id, targetEmail: u.email, ip: meta.ip, userAgent: meta.userAgent, detail: 'self-service' });
    return { ok: true };
  }

  async logout(user: { sub: string; email: string; jti?: string }, meta: ReqMeta = {}) {
    if (user.jti) await this.prisma.session.update({ where: { id: user.jti }, data: { revokedAt: new Date() } }).catch(() => undefined);
    await this.audit.record({ action: 'logout', actorEmail: user.email, actorId: user.sub, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true };
  }

  // ── Session management ──────────────────────────────────────────
  async listSessions(userId: string, currentJti?: string) {
    const now = new Date();
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === currentJti,
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const s = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!s || s.userId !== userId) throw new BadRequestException('session not found');
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  // ── Forgot / reset password ─────────────────────────────────────
  /** Always returns ok (never reveals whether the email exists). */
  async forgotPassword(email?: string, meta: ReqMeta = {}) {
    const e = (email || '').trim().toLowerCase();
    const user = e ? await this.prisma.user.findUnique({ where: { email: e } }) : null;
    let emailSent = false;
    if (user && user.status === 'active') {
      const token = randomBytes(32).toString('hex');
      await this.prisma.passwordReset.create({ data: { userId: user.id, token, purpose: 'password', expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
      const link = `${this.webOrigin()}/reset?token=${token}`;
      emailSent = await this.sendResetEmail(user.email, link);
      if (!emailSent) {
        // No SMTP configured — surface the link to the server operator only (never to the client).
        this.log.warn(`password reset link for ${user.email} (SMTP not configured): ${link}`);
      }
      await this.audit.record({ action: 'password_reset', actorEmail: user.email, actorId: user.id, ip: meta.ip, userAgent: meta.userAgent, detail: emailSent ? 'reset requested (emailed)' : 'reset requested (no SMTP — see server log)' });
    }
    return { ok: true, emailConfigured: emailEnabled() };
  }

  async resetPassword(token?: string, newPassword?: string, meta: ReqMeta = {}) {
    if (!token) throw new BadRequestException('invalid reset link');
    if (!newPassword || newPassword.length < 10) throw new BadRequestException('new password must be at least 10 characters');
    const pr = await this.prisma.passwordReset.findUnique({ where: { token } });
    if (!pr || pr.usedAt || pr.expiresAt.getTime() < Date.now()) throw new BadRequestException('this reset link is invalid or has expired');
    const user = await this.prisma.user.findUnique({ where: { id: pr.userId } });
    if (!user) throw new BadRequestException('account no longer exists');
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(newPassword) } });
    await this.prisma.passwordReset.update({ where: { id: pr.id }, data: { usedAt: new Date() } });
    // Security: revoke all existing sessions on a password reset.
    await this.prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ action: 'password_changed', actorEmail: user.email, actorId: user.id, targetEmail: user.email, ip: meta.ip, userAgent: meta.userAgent, detail: 'via reset link' });
    return { ok: true };
  }

  /** Forgot-2FA: email a one-time link that disables 2FA so the user can sign in + re-enrol. */
  async forgot2fa(email?: string, meta: ReqMeta = {}) {
    const e = (email || '').trim().toLowerCase();
    const user = e ? await this.prisma.user.findUnique({ where: { email: e } }) : null;
    let emailSent = false;
    if (user && user.totpEnabled) {
      const token = randomBytes(32).toString('hex');
      await this.prisma.passwordReset.create({ data: { userId: user.id, token, purpose: '2fa', expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
      const link = `${this.webOrigin()}/reset?token=${token}&mode=2fa`;
      emailSent = await this.sendResetEmail(user.email, link, '2fa');
      if (!emailSent) this.log.warn(`2FA reset link for ${user.email} (no SMTP): ${link}`);
      await this.audit.record({ action: 'login_failed', actorEmail: user.email, actorId: user.id, ip: meta.ip, userAgent: meta.userAgent, detail: emailSent ? '2FA reset requested (emailed)' : '2FA reset requested (no SMTP — see server log)' });
    }
    return { ok: true, emailConfigured: emailEnabled() };
  }

  /** Consume a 2FA-reset token → turn off 2FA so the user can sign in with their password. */
  async reset2faToken(token?: string, meta: ReqMeta = {}) {
    if (!token) throw new BadRequestException('invalid link');
    const pr = await this.prisma.passwordReset.findUnique({ where: { token } });
    if (!pr || pr.purpose !== '2fa' || pr.usedAt || pr.expiresAt.getTime() < Date.now()) throw new BadRequestException('this link is invalid or has expired');
    const user = await this.prisma.user.findUnique({ where: { id: pr.userId } });
    if (!user) throw new BadRequestException('account no longer exists');
    await this.prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null, totpPending: null, recoveryCodes: [] } });
    await this.prisma.passwordReset.update({ where: { id: pr.id }, data: { usedAt: new Date() } });
    await this.audit.record({ action: 'password_changed', actorEmail: user.email, actorId: user.id, targetEmail: user.email, ip: meta.ip, userAgent: meta.userAgent, detail: '2FA disabled via recovery link' });
    return { ok: true, email: user.email };
  }

  private webOrigin(): string {
    return (process.env.WEB_ORIGIN?.split(',')[0] || 'http://localhost:3000').trim();
  }

  private async sendResetEmail(to: string, link: string, kind: 'password' | '2fa' = 'password'): Promise<boolean> {
    try {
      const subject = kind === '2fa' ? '[MCMF] Reset two-factor authentication' : '[MCMF] Reset your password';
      const body = kind === '2fa'
        ? `A two-factor (2FA) reset was requested for your MCMF account.\n\nClick to disable 2FA (valid 30 minutes), then sign in with your password and re-enrol:\n${link}\n\nIf you did not request this, ignore this email.`
        : `A password reset was requested for your MCMF account.\n\nReset link (valid 30 minutes):\n${link}\n\nIf you did not request this, ignore this email.`;
      // Sends via external SMTP relay if configured, else MCMF's built-in sender.
      await sendMail({ to, subject, text: body });
      return true;
    } catch (err) {
      this.log.warn(`reset email to ${to} failed: ${String((err as Error)?.message ?? err)}`);
      return false;
    }
  }
}
