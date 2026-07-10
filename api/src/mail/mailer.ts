import * as nodemailer from 'nodemailer';
import * as dns from 'node:dns/promises';

/**
 * Unified mailer with two modes:
 *  - relay   : an external SMTP is configured (SMTP_HOST set) → send through it.
 *  - builtin : no external SMTP → MCMF's own "open" sender delivers straight to
 *              the recipient domain's MX on port 25, from no-reply@mcmf.edu.
 *
 * So adding an external SMTP turns the built-in off; removing it turns the
 * built-in back on automatically — no other config needed.
 */

export const MAIL_DOMAIN = (process.env.MCMF_MAIL_DOMAIN || 'mcmf.edu').trim();
export const DEFAULT_FROM = `MCMF <no-reply@${MAIL_DOMAIN}>`;

/**
 * Active DKIM sending identity. When an email Domain is verified + activated, DomainsService pushes its
 * config here so every outgoing message is sent FROM that domain and DKIM-signed (so SPF/DKIM/DMARC pass).
 * Null = no managed domain → fall back to the default sender.
 */
let ACTIVE_DKIM: { domain: string; selector: string; privateKey: string; from: string } | null = null;
export function setActiveDkim(d: { domain: string; selector: string; privateKey: string; from: string } | null) { ACTIVE_DKIM = d; }
export function activeDkim() { return ACTIVE_DKIM; }

export type MailMode = 'relay' | 'builtin';

/** External relay is active only when an SMTP host is configured. */
export function mailMode(): MailMode {
  return process.env.SMTP_HOST && process.env.SMTP_HOST.trim() ? 'relay' : 'builtin';
}

/** Email can always be sent — via relay if configured, else the built-in sender. */
export function emailEnabled(): boolean {
  return true;
}

function fromAddress(): string {
  // Built-in mode always sends from the mcmf.edu default. Relay mode honors the
  // external SMTP's configured From (or its username), falling back to default.
  if (mailMode() === 'builtin') return DEFAULT_FROM;
  return (process.env.SMTP_FROM || '').trim() || process.env.SMTP_USER || DEFAULT_FROM;
}

export interface MailOpts {
  to: string; // one address, or comma-separated
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content?: Buffer | string; path?: string }[];
}

function dkimOpt() {
  return ACTIVE_DKIM ? { dkim: { domainName: ACTIVE_DKIM.domain, keySelector: ACTIVE_DKIM.selector, privateKey: ACTIVE_DKIM.privateKey } } : {};
}

function relayTransport() {
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    ...(user ? { auth: { user, pass: process.env.SMTP_PASS } } : {}),
    ...dkimOpt(),
  });
}

/** Non-destructive email health check — verifies the SMTP relay (handshake + auth) without sending. */
export async function verifyMail(): Promise<{ ok: boolean; detail: string }> {
  if (mailMode() !== 'relay') return { ok: true, detail: 'built-in sender (no external SMTP to verify)' };
  try {
    await relayTransport().verify();
    return { ok: true, detail: `SMTP relay ${process.env.SMTP_HOST}:${process.env.SMTP_PORT ?? 587} reachable & authenticated` };
  } catch (e) {
    return { ok: false, detail: `SMTP verify failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
}

/** Built-in "open" delivery: resolve the recipient's MX and hand the mail off on port 25 (no auth). */
async function directSendOne(addr: string, base: nodemailer.SendMailOptions) {
  const domain = addr.split('@')[1]?.trim();
  if (!domain) throw new Error(`invalid recipient address: ${addr}`);
  const mx = (await dns.resolveMx(domain).catch((): { exchange: string; priority: number }[] => [])).sort((a, b) => a.priority - b.priority);
  if (!mx.length) throw new Error(`no MX records for ${domain} — cannot deliver`);
  let lastErr: unknown;
  for (const rec of mx.slice(0, 3)) {
    try {
      const transport = nodemailer.createTransport({
        host: rec.exchange,
        port: 25,
        secure: false,
        name: MAIL_DOMAIN, // HELO/EHLO name
        tls: { rejectUnauthorized: false },
        connectionTimeout: 12000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        ...dkimOpt(),
      });
      return await transport.sendMail({ ...base, to: addr });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`direct delivery to ${domain} failed: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

/** Send an email through the active mode. Throws on failure. */
export async function sendMail(opts: MailOpts) {
  const base: nodemailer.SendMailOptions = {
    // When a managed email domain is active, send FROM it (DKIM signing is set on the transport below).
    from: ACTIVE_DKIM ? ACTIVE_DKIM.from : fromAddress(),
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments,
  };
  if (mailMode() === 'relay') {
    return relayTransport().sendMail({ ...base, to: opts.to });
  }
  // built-in: deliver per-recipient (each domain has its own MX)
  const recipients = opts.to.split(',').map((s) => s.trim()).filter(Boolean);
  const results = await Promise.all(recipients.map((r) => directSendOne(r, base)));
  return results[results.length - 1];
}
