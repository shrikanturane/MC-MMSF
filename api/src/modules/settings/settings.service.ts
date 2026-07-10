import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Provider } from '@prisma/client';
import { bustSysParams } from '../../system-params';
import { verifyTotp } from '../../auth/totp';

// Curated deploy-time env surfaced to admins (Settings → Environment & Secrets). Infra = shown plainly;
// secret = masked, revealed only with a fresh 2FA code. Add a key here to surface it.
const ENV_VARS: { key: string; label: string; group: 'infra' | 'secret'; secret: boolean }[] = [
  { key: 'SSO_BASE_URL', label: 'App base URL', group: 'infra', secret: false },
  { key: 'PORT', label: 'API port', group: 'infra', secret: false },
  { key: 'NODE_ENV', label: 'Node environment', group: 'infra', secret: false },
  { key: 'WEB_ORIGIN', label: 'Web origin (CORS)', group: 'infra', secret: false },
  { key: 'CLICKHOUSE_URL', label: 'ClickHouse URL', group: 'infra', secret: false },
  { key: 'GUACD_HOST', label: 'guacd host', group: 'infra', secret: false },
  { key: 'GUACD_PORT', label: 'guacd port', group: 'infra', secret: false },
  { key: 'DATABASE_URL', label: 'Database URL (contains password)', group: 'secret', secret: true },
  { key: 'APP_ENCRYPTION_KEY', label: 'Vault master key (AES-256-GCM)', group: 'secret', secret: true },
  { key: 'AGENT_KEY', label: 'Agent enrolment key', group: 'secret', secret: true },
  { key: 'SMTP_PASS', label: 'SMTP password', group: 'secret', secret: true },
  { key: 'MS_CLIENT_SECRET', label: 'Microsoft SSO client secret', group: 'secret', secret: true },
  { key: 'GOOGLE_CLIENT_SECRET', label: 'Google SSO client secret', group: 'secret', secret: true },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', group: 'secret', secret: true },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key', group: 'secret', secret: true },
  { key: 'GEMINI_API_KEY', label: 'Gemini API key', group: 'secret', secret: true },
  { key: 'WHATSAPP_TOKEN', label: 'WhatsApp API token', group: 'secret', secret: true },
];

function maskSecret(key: string, v: string): string {
  if (!v) return '';
  if (key === 'DATABASE_URL') return v.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:••••••@'); // redact only the password
  return v.length <= 6 ? '••••••' : `${v.slice(0, 2)}••••••${v.slice(-4)}`;
}
import { countryOf } from '../access/access-control.middleware';

const PROVIDERS: Provider[] = ['aws', 'azure', 'gcp', 'private'];

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getOrg() {
    return this.prisma.orgSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  }

  async getAll() {
    const [org, accounts, integrations] = await Promise.all([
      this.getOrg(),
      this.prisma.cloudAccount.findMany(),
      this.prisma.integration.findMany(),
    ]);

    // Cloud connections summarized per provider.
    const connections = PROVIDERS.map((provider) => {
      const accs = accounts.filter((a) => a.provider === provider);
      const errored = accs.some((a) => a.status === 'error' || a.status === 'disconnected');
      return {
        provider,
        accounts: accs.length,
        status: accs.length === 0 ? 'disconnected' : errored ? 'warning' : 'connected',
      };
    });

    return {
      profile: {
        userName: org.userName,
        userEmail: org.userEmail,
        userRole: org.userRole,
        orgName: org.orgName,
      },
      region: {
        timezone: org.timezone,
        dateFormat: org.dateFormat,
        currency: org.currency,
        language: org.language,
      },
      branding: {
        orgName: org.orgName,
        primaryColor: org.primaryColor,
        tagline: (org as any).tagline ?? 'Multi-Cloud Platform',
        theme: (org as any).theme ?? 'midnight',
        logo: org.logo,
        bgImage: (org as any).bgImage ?? '',
        fontScale: (org as any).fontScale ?? 'base',
        fontFamily: (org as any).fontFamily ?? 'system',
        reduceMotion: (org as any).reduceMotion ?? false,
        highContrast: (org as any).highContrast ?? false,
        solidSurfaces: (org as any).solidSurfaces ?? false,
      },
      modules: org.modules,
      layout: org.layout,
      logRetentionDays: org.logRetentionDays,
      provisioningEnabled: (org as any).provisioningEnabled ?? false,
      makerChecker: (org as any).makerChecker ?? false,
      // Operator-tunable system parameters (Settings → System Parameters).
      systemParams: {
        monitorIntervalSec: (org as any).monitorIntervalSec ?? 30,
        alertEvalSec: (org as any).alertEvalSec ?? 60,
        agentOfflineSec: (org as any).agentOfflineSec ?? 300,
        agentRetentionDays: (org as any).agentRetentionDays ?? 14,
        approvalExpiryDays: (org as any).approvalExpiryDays ?? 7,
        logTtlSettingDays: (org as any).logTtlSettingDays ?? 30,
        sessionTimeoutHours: (org as any).sessionTimeoutHours ?? 12,
      },
      connections,
      integrations: integrations.map((i) => ({
        id: i.id,
        name: i.name,
        kind: i.kind,
        target: i.target,
        status: i.status,
      })),
    };
  }

  async update(body: any) {
    const data: any = {};
    for (const k of ['orgName', 'userName', 'userEmail', 'userRole', 'timezone', 'dateFormat', 'currency', 'language', 'primaryColor', 'tagline', 'theme', 'logo', 'bgImage', 'fontScale', 'fontFamily', 'reduceMotion', 'highContrast', 'solidSurfaces']) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    if (body.modules !== undefined) data.modules = body.modules;
    if (body.layout !== undefined) data.layout = body.layout;
    if (body.logRetentionDays !== undefined) {
      const n = Math.round(Number(body.logRetentionDays));
      // Clamp to a sane compliance range: 7 days … 10 years.
      data.logRetentionDays = Math.max(7, Math.min(3650, isNaN(n) ? 90 : n));
    }
    if (body.require2fa !== undefined) data.require2fa = !!body.require2fa;
    if (body.provisioningEnabled !== undefined) data.provisioningEnabled = !!body.provisioningEnabled;
    // NOTE: makerChecker is intentionally NOT settable here — it goes through setMakerChecker() so that
    // DISABLING it (weakening segregation of duties) requires a fresh 2FA code.
    // System parameters — clamp each to a sane range so a typo can't break the platform.
    const clampInt = (v: any, min: number, max: number, def: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };
    const sp = body.systemParams ?? {};
    if (sp.monitorIntervalSec !== undefined) data.monitorIntervalSec = clampInt(sp.monitorIntervalSec, 5, 3600, 30);
    if (sp.alertEvalSec !== undefined) data.alertEvalSec = clampInt(sp.alertEvalSec, 10, 3600, 60);
    if (sp.agentOfflineSec !== undefined) data.agentOfflineSec = clampInt(sp.agentOfflineSec, 30, 86400, 300);
    if (sp.agentRetentionDays !== undefined) data.agentRetentionDays = clampInt(sp.agentRetentionDays, 1, 3650, 14);
    if (sp.approvalExpiryDays !== undefined) data.approvalExpiryDays = clampInt(sp.approvalExpiryDays, 1, 365, 7);
    if (sp.logTtlSettingDays !== undefined) data.logTtlSettingDays = clampInt(sp.logTtlSettingDays, 1, 3650, 30);
    if (sp.sessionTimeoutHours !== undefined) data.sessionTimeoutHours = clampInt(sp.sessionTimeoutHours, 1, 720, 12);
    await this.prisma.orgSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
    bustSysParams(); // apply tunables immediately (the 20s cache would otherwise delay them)
    return this.getAll();
  }

  /**
   * Deploy-time environment for admin visibility. Infra-bootstrap values are shown plainly (helpful
   * for ops); secrets are MASKED and only revealed via revealEnv() after a fresh 2FA code. These stay
   * env-managed (a restart applies a change) — the panel surfaces them, it doesn't write the env.
   */
  environment() {
    return ENV_VARS.map((e) => {
      const raw = process.env[e.key] ?? '';
      const set = raw.length > 0;
      return { key: e.key, label: e.label, group: e.group, secret: e.secret, set, value: e.secret ? maskSecret(e.key, raw) : raw };
    });
  }

  /**
   * Toggle maker-checker (segregation of duties). Turning it ON is always allowed; turning it OFF
   * weakens a security control, so it requires a fresh 2FA code from the requesting admin. Audited both ways.
   */
  async setMakerChecker(userId: string, enabled: boolean, code: string) {
    const org: any = await this.prisma.orgSettings.findUnique({ where: { id: 1 } });
    const current = !!org?.makerChecker;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (current && !enabled) {
      // Disabling segregation-of-duties → require 2FA.
      if (!user?.totpEnabled || !user.totpSecret) throw new BadRequestException('Enable two-factor authentication first — disabling maker-checker requires a 2FA code.');
      if (!verifyTotp(user.totpSecret, String(code || '').trim())) throw new BadRequestException('Invalid 2FA code — check your authenticator and try again.');
      await this.prisma.eventLog.create({ data: { type: 'control', severity: 'warning', title: `${user.email} DISABLED maker-checker (2FA verified)` } }).catch(() => undefined);
    } else if (current !== enabled) {
      await this.prisma.eventLog.create({ data: { type: 'control', severity: 'info', title: `${user?.email || 'admin'} enabled maker-checker` } }).catch(() => undefined);
    }
    await this.prisma.orgSettings.upsert({ where: { id: 1 }, update: { makerChecker: enabled }, create: { id: 1, makerChecker: enabled } });
    return this.getAll();
  }

  /** Reveal the full secret env values — gated by a fresh TOTP code from the requesting admin. */
  async revealEnv(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.totpEnabled || !user.totpSecret) throw new BadRequestException('Enable two-factor authentication first to reveal secrets.');
    if (!verifyTotp(user.totpSecret, String(code || '').trim())) throw new BadRequestException('Invalid 2FA code — check your authenticator and try again.');
    await this.prisma.eventLog.create({ data: { type: 'control', severity: 'warning', title: `${user.email} revealed environment secrets (2FA verified)` } }).catch(() => undefined);
    return ENV_VARS.filter((e) => e.secret).map((e) => ({ key: e.key, value: process.env[e.key] ?? '' }));
  }

  /** Network access blocklist (admin). yourIp + yourCountry echoed so an admin doesn't lock themselves out. */
  async getBlocklist(yourIp: string) {
    const s: any = await this.getOrg();
    return {
      enabled: s.blocklistEnabled ?? false,
      entries: (s.accessBlocklist as any[]) ?? [],
      countryMode: s.countryMode ?? 'off',
      countryList: (s.countryList as string[]) ?? [],
      yourIp,
      yourCountry: countryOf(yourIp),
    };
  }

  async setBlocklist(body: { enabled?: boolean; entries?: any[]; countryMode?: string; countryList?: string[] }) {
    const TYPES = ['ip', 'cidr', 'range'];
    const entries = Array.isArray(body?.entries)
      ? body.entries
          .filter((e) => e && TYPES.includes(e.type) && String(e.value || '').trim())
          .slice(0, 1000)
          .map((e) => ({ type: e.type, value: String(e.value).trim(), note: String(e.note || '').slice(0, 200), enabled: e.enabled !== false }))
      : [];
    const countryMode = ['off', 'allow', 'block'].includes(String(body?.countryMode)) ? String(body!.countryMode) : 'off';
    const countryList = Array.isArray(body?.countryList)
      ? [...new Set(body!.countryList.map((c) => String(c).toUpperCase().trim()).filter((c) => /^[A-Z]{2}$/.test(c)))].slice(0, 300)
      : [];
    await this.prisma.orgSettings.upsert({
      where: { id: 1 },
      update: { blocklistEnabled: !!body?.enabled, accessBlocklist: entries as any, countryMode, countryList: countryList as any },
      create: { id: 1, blocklistEnabled: !!body?.enabled, accessBlocklist: entries as any, countryMode, countryList: countryList as any },
    });
    return { ok: true, enabled: !!body?.enabled, entries, countryMode, countryList };
  }

  /** Store a branding image (logo / background). Accepts a data-URL or raw base64. Returns its URL. */
  async saveAsset(data: string, mimeHint: string) {
    let b64 = data;
    let mime = mimeHint || 'application/octet-stream';
    const m = /^data:([^;]+);base64,(.*)$/s.exec(data);
    if (m) { mime = m[1]; b64 = m[2]; }
    if (!b64) throw new BadRequestException('no image data provided');
    if (!/^image\//.test(mime)) throw new BadRequestException('only image files are allowed');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) throw new BadRequestException('image data is empty or invalid');
    if (buf.length > 8 * 1024 * 1024) throw new BadRequestException('file too large (max 8 MB)');
    const asset = await this.prisma.asset.create({ data: { mime, data: buf } });
    return { url: `/api/settings/asset/${asset.id}` };
  }

  async getAsset(id: string): Promise<{ mime: string; data: Buffer } | null> {
    const a = await this.prisma.asset.findUnique({ where: { id } });
    return a ? { mime: a.mime, data: Buffer.from(a.data) } : null;
  }
}
