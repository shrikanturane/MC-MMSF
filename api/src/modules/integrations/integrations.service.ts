import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { encryptJson, decryptJson } from '../../connectors/crypto';
import { sendMail, mailMode, DEFAULT_FROM, verifyMail } from '../../mail/mailer';

export const INTEGRATION_FIELDS = [
  { key: 'SSO_BASE_URL', label: 'App base URL (HTTPS)', group: 'sso', provider: 'sso-common', secret: false, hint: 'e.g. https://localhost' },
  { key: 'SSO_AUTO_PROVISION', label: 'Auto-create SSO users as Viewer (0/1)', group: 'sso', provider: 'sso-common', secret: false },
  { key: 'GOOGLE_CLIENT_ID', label: 'Google Client ID', group: 'sso', provider: 'google', secret: false },
  { key: 'GOOGLE_CLIENT_SECRET', label: 'Google Client Secret', group: 'sso', provider: 'google', secret: true },
  { key: 'MS_CLIENT_ID', label: 'Microsoft Client ID', group: 'sso', provider: 'microsoft', secret: false },
  { key: 'MS_CLIENT_SECRET', label: 'Microsoft Client Secret', group: 'sso', provider: 'microsoft', secret: true },
  { key: 'MS_TENANT', label: 'Microsoft Tenant (id or "common")', group: 'sso', provider: 'microsoft', secret: false },
  { key: 'SMTP_HOST', label: 'SMTP Host', group: 'email', provider: 'email', secret: false },
  { key: 'SMTP_PORT', label: 'SMTP Port (587/465)', group: 'email', provider: 'email', secret: false },
  { key: 'SMTP_USER', label: 'SMTP Username', group: 'email', provider: 'email', secret: false },
  { key: 'SMTP_PASS', label: 'SMTP Password', group: 'email', provider: 'email', secret: true },
  { key: 'SMTP_FROM', label: 'From address', group: 'email', provider: 'email', secret: false },
  { key: 'WHATSAPP_PHONE_ID', label: 'WhatsApp Phone Number ID', group: 'whatsapp', provider: 'whatsapp', secret: false },
  { key: 'WHATSAPP_TOKEN', label: 'WhatsApp Access Token', group: 'whatsapp', provider: 'whatsapp', secret: true },
  { key: 'AI_PROVIDER', label: 'AI Provider', group: 'ai', provider: 'ai', secret: false, hint: 'local | free | anthropic | openai | gemini  (use openai for any OpenAI-compatible API: NVIDIA, Groq, Together, OpenRouter; blank = auto-detect)' },
  { key: 'AI_LOCAL_MODEL', label: 'Local AI Model (Ollama)', group: 'ai', provider: 'ai', secret: false, hint: 'on-prem model served by Ollama, e.g. qwen2.5:1.5b-instruct' },
  { key: 'OLLAMA_URL', label: 'Local AI Engine URL (Ollama)', group: 'ai', provider: 'ai', secret: false, hint: 'http://ollama:11434 (in-cluster) — leave default unless self-hosting elsewhere' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key (Claude)', group: 'ai', provider: 'ai', secret: true, hint: 'sk-ant-… (console.anthropic.com) — paid' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI / compatible API Key', group: 'ai', provider: 'ai', secret: true, hint: 'sk-… (OpenAI) OR nvapi-… (NVIDIA, FREE: build.nvidia.com) OR any OpenAI-compatible key' },
  { key: 'OPENAI_BASE_URL', label: 'OpenAI-compatible Base URL (optional)', group: 'ai', provider: 'ai', secret: false, hint: 'blank = OpenAI. NVIDIA free API → https://integrate.api.nvidia.com/v1 · Groq → https://api.groq.com/openai/v1' },
  { key: 'GEMINI_API_KEY', label: 'Google Gemini API Key', group: 'ai', provider: 'ai', secret: true, hint: 'AIza… (aistudio.google.com — has a free tier)' },
  { key: 'AI_MODEL', label: 'Cloud Model (optional)', group: 'ai', provider: 'ai', secret: false, hint: 'blank = provider default. NVIDIA e.g. meta/llama-3.3-70b-instruct or nvidia/llama-3.1-nemotron-70b-instruct · OpenAI gpt-4o-mini' },
  { key: 'AI_RATE_PER_MIN', label: 'Cloud AI rate cap — per minute', group: 'ai', provider: 'ai', secret: false, hint: 'max cloud-LLM calls/min before falling back to the instant native engine (default 20; 0 = unlimited)' },
  { key: 'AI_RATE_PER_DAY', label: 'Cloud AI rate cap — per day', group: 'ai', provider: 'ai', secret: false, hint: 'max cloud-LLM calls/day before falling back to native (default 1000; 0 = unlimited). A provider 429 auto-cools-down, then retries.' },
] as const;

/** Per-provider keys cleared when an integration is removed (shared sso-common keys are left alone). */
const PROVIDER_OWN_KEYS: Record<string, string[]> = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  microsoft: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT'],
  email: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
  whatsapp: ['WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN'],
  ai: ['AI_PROVIDER', 'AI_LOCAL_MODEL', 'OLLAMA_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'AI_MODEL', 'AI_RATE_PER_MIN', 'AI_RATE_PER_DAY'],
};

/** Turn a Meta Graph API WhatsApp error into a clear, actionable message. Code 190 = token expired. */
function whatsappError(status: number, body: string): string {
  let code: number | undefined;
  let message = '';
  try { const j = JSON.parse(body); code = j?.error?.code; message = j?.error?.message ?? ''; } catch { /* non-JSON */ }
  if (code === 190 || /expired|session has expired/i.test(message)) {
    return 'WhatsApp access token EXPIRED (code 190). The temporary token lasts ~24h — generate a permanent System-User token: Help → User Guide → "WhatsApp access token (permanent)", then update it in Settings → Integrations → WhatsApp.';
  }
  if (code === 100) return `WhatsApp request error (code 100): ${message || 'check the Phone Number ID'}.`;
  if (status === 401 || status === 403) return `WhatsApp auth failed (${status}): ${message || 'invalid token or missing permissions'}.`;
  return `WhatsApp ${status}: ${(message || body).slice(0, 160)}`;
}

@Injectable()
export class IntegrationsService implements OnModuleInit {
  private readonly log = new Logger('Integrations');
  private lastHealth: Record<string, { ok: boolean; detail: string; at: string }> = {};
  constructor(private readonly prisma: PrismaService, private readonly ai: AiService) {}

  async onModuleInit() {
    await this.seedDefaults().catch((e) => this.log.warn(`seedDefaults: ${String(e)}`));
    await this.applyToEnv().catch((e) => this.log.warn(`applyToEnv: ${String(e)}`));
    // Hourly health check of every configured integration — failures raise an alert.
    setTimeout(() => this.runHealthChecks().catch(() => undefined), 90_000);
    setInterval(() => this.runHealthChecks().catch(() => undefined), 60 * 60_000);
  }

  /** Integrations that have their credentials configured (only these are health-checked). */
  private configuredProviders(): string[] {
    const has = (k: string) => !!process.env[k];
    const list = ['email']; // built-in sender is always present
    if (has('WHATSAPP_TOKEN') && has('WHATSAPP_PHONE_ID')) list.push('whatsapp');
    if (has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET')) list.push('google');
    if (has('MS_CLIENT_ID') && has('MS_CLIENT_SECRET')) list.push('microsoft');
    if (has('ANTHROPIC_API_KEY') || has('OPENAI_API_KEY') || has('GEMINI_API_KEY')) list.push('ai');
    return list;
  }

  /** Non-destructive health probe (never sends a message / costs money). */
  async healthCheck(provider: string): Promise<{ ok: boolean; detail: string }> {
    await this.applyToEnv();
    if (provider === 'email') return verifyMail();
    if (provider === 'whatsapp') {
      const token = process.env.WHATSAPP_TOKEN;
      const phoneId = process.env.WHATSAPP_PHONE_ID;
      if (!token || !phoneId) return { ok: false, detail: 'WhatsApp token / phone id not set' };
      try {
        const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}?fields=id,display_phone_number`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) return { ok: false, detail: whatsappError(res.status, await res.text()) };
        const j: any = await res.json().catch(() => ({}));
        return { ok: true, detail: `token valid${j?.display_phone_number ? ` (${j.display_phone_number})` : ''}` };
      } catch (e) {
        return { ok: false, detail: `WhatsApp check failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
      }
    }
    if (provider === 'google' || provider === 'microsoft') {
      const base = process.env.SSO_BASE_URL;
      const id = process.env[provider === 'google' ? 'GOOGLE_CLIENT_ID' : 'MS_CLIENT_ID'];
      const sec = !!process.env[provider === 'google' ? 'GOOGLE_CLIENT_SECRET' : 'MS_CLIENT_SECRET'];
      if (!base) return { ok: false, detail: 'App base URL (SSO_BASE_URL) not set' };
      if (!id || !sec) return { ok: false, detail: 'Client ID / Secret not set' };
      return { ok: true, detail: 'OAuth config present' };
    }
    if (provider === 'ai') {
      const set = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'].some((k) => process.env[k]);
      return set ? { ok: true, detail: 'API key set' } : { ok: false, detail: 'no AI API key set' };
    }
    return { ok: true, detail: 'no health check for this integration' };
  }

  /** Run the hourly health checks: store the result and raise/resolve an alert per integration. */
  async runHealthChecks() {
    for (const provider of this.configuredProviders()) {
      let r: { ok: boolean; detail: string };
      try { r = await this.healthCheck(provider); } catch (e) { r = { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 160) }; }
      this.lastHealth[provider] = { ok: r.ok, detail: r.detail, at: new Date().toISOString() };
      const source = `integration:${provider}`;
      const open = await this.prisma.alert.findFirst({ where: { source, status: 'active' as any } }).catch(() => null);
      if (!r.ok && !open) {
        await this.prisma.alert.create({ data: { title: `Integration unhealthy: ${provider} — ${r.detail}`, severity: 'high' as any, source, status: 'active' as any } }).catch(() => undefined);
        await this.prisma.eventLog.create({ data: { type: 'system', severity: 'critical', title: `Integration ${provider} failed health check`, detail: r.detail } }).catch(() => undefined);
        this.log.warn(`integration ${provider} UNHEALTHY: ${r.detail}`);
      } else if (r.ok && open) {
        await this.prisma.alert.update({ where: { id: open.id }, data: { status: 'resolved' as any, resolvedAt: new Date() } }).catch(() => undefined);
        await this.prisma.eventLog.create({ data: { type: 'system', severity: 'info', title: `Integration ${provider} recovered`, detail: r.detail } }).catch(() => undefined);
      }
    }
    return this.health();
  }

  /** Last health result per integration (for the UI badge). */
  health() {
    return Object.entries(this.lastHealth).map(([provider, h]) => ({ provider, ok: h.ok, detail: h.detail, at: h.at }));
  }

  /** Email is the default, always-present integration: seed sane SMTP defaults on first boot. */
  private async seedDefaults() {
    const existing = await this.prisma.integrationSetting.findFirst({ where: { key: { in: ['SMTP_PORT', 'SMTP_FROM', 'SMTP_HOST'] } } });
    if (existing) return;
    const defaults: Record<string, string> = {
      SMTP_PORT: process.env.SMTP_PORT || '587',
      SMTP_FROM: process.env.SMTP_FROM || DEFAULT_FROM, // built-in default: no-reply@mcmf.edu
    };
    for (const [key, value] of Object.entries(defaults)) {
      await this.prisma.integrationSetting.upsert({ where: { key }, update: {}, create: { key, value, secret: false } });
      process.env[key] = value;
    }
    this.log.log(`Seeded default Email (SMTP) integration — built-in sender active (${mailMode()} mode). Add SMTP_HOST in Settings → Integrations to use an external relay.`);
  }

  /** Push stored config into process.env so SSO / SMTP / WhatsApp consumers read it. */
  async applyToEnv() {
    const rows = await this.prisma.integrationSetting.findMany();
    for (const r of rows) {
      let v = r.value;
      if (r.secret && v) {
        try {
          v = decryptJson<string>(v);
        } catch {
          v = '';
        }
      }
      if (v) process.env[r.key] = v;
    }
  }

  /** UI view: never returns secret values, only whether they're set. */
  async getConfig() {
    const rows = await this.prisma.integrationSetting.findMany();
    const map = new Map(rows.map((r) => [r.key, r]));
    return INTEGRATION_FIELDS.map((f) => {
      const row = map.get(f.key);
      const envVal = process.env[f.key] ?? '';
      const plain = !f.secret ? (row?.value ?? envVal ?? '') : '';
      const set = f.secret ? !!(row?.value || envVal) : plain !== '';
      return { key: f.key, label: f.label, group: f.group, provider: f.provider, secret: f.secret, hint: (f as any).hint ?? '', set, value: plain };
    });
  }

  /** Clear an integration's own credentials (DELETE /integrations/:provider). */
  async remove(provider: string) {
    const keys = PROVIDER_OWN_KEYS[provider];
    if (!keys) throw new BadRequestException(`Unknown integration "${provider}"`);
    await this.prisma.integrationSetting.deleteMany({ where: { key: { in: keys } } });
    for (const k of keys) delete process.env[k];
    await this.applyToEnv();
    return { ok: true };
  }

  /** Live test of an integration's credentials. Email/WhatsApp actually send; SSO validates config. */
  async test(provider: string, to?: string): Promise<{ ok: boolean; detail: string }> {
    await this.applyToEnv();
    if (provider === 'email') {
      if (!to) throw new BadRequestException('Enter a recipient email to test.');
      const mode = mailMode();
      await sendMail({
        to,
        subject: '[MCMF] Test email',
        text: `This is a test message from MCMF.\n\nSent via the ${mode === 'relay' ? 'external SMTP relay' : 'built-in MCMF sender (direct delivery)'}. Email delivery is working.`,
      });
      return { ok: true, detail: `Test email sent to ${to} via ${mode === 'relay' ? 'external SMTP' : 'built-in sender'}.` };
    }
    if (provider === 'whatsapp') {
      const token = process.env.WHATSAPP_TOKEN;
      const phoneId = process.env.WHATSAPP_PHONE_ID;
      if (!token || !phoneId) throw new BadRequestException('Set WhatsApp Phone Number ID and Access Token first.');
      if (!to) throw new BadRequestException('Enter a recipient phone number (with country code) to test.');
      const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/[^0-9]/g, ''), type: 'text', text: { body: 'MCMF test message — your WhatsApp integration is working.' } }),
      });
      if (!res.ok) throw new BadRequestException(whatsappError(res.status, await res.text()));
      return { ok: true, detail: `Test WhatsApp message sent to ${to}.` };
    }
    if (provider === 'google' || provider === 'microsoft') {
      const base = process.env.SSO_BASE_URL;
      if (!base) throw new BadRequestException('Set the App base URL (HTTPS) first.');
      const id = process.env[provider === 'google' ? 'GOOGLE_CLIENT_ID' : 'MS_CLIENT_ID'];
      const secretSet = !!process.env[provider === 'google' ? 'GOOGLE_CLIENT_SECRET' : 'MS_CLIENT_SECRET'];
      if (!id || !secretSet) throw new BadRequestException('Set both the Client ID and Client Secret.');
      const redirect = `${base.replace(/\/$/, '')}/api/auth/sso/${provider}/callback`;
      return { ok: true, detail: `Config looks valid. Register this redirect URI with the provider: ${redirect}` };
    }
    if (provider === 'ai') {
      return this.ai.selfTest();
    }
    throw new BadRequestException(`Unknown integration "${provider}"`);
  }

  async update(patch: Record<string, string>) {
    for (const f of INTEGRATION_FIELDS) {
      if (!(f.key in patch)) continue;
      const raw = (patch[f.key] ?? '').trim();
      if (f.secret && raw === '') continue; // blank secret = keep existing
      const value = f.secret ? (raw ? encryptJson(raw) : '') : raw;
      await this.prisma.integrationSetting.upsert({
        where: { key: f.key },
        update: { value, secret: f.secret },
        create: { key: f.key, value, secret: f.secret },
      });
      if (!f.secret) process.env[f.key] = raw; // immediate effect, incl. clearing
    }
    await this.applyToEnv();
    return { ok: true };
  }
}
