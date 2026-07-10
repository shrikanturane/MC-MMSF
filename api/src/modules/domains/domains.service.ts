import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as dns from 'node:dns/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { TlsService } from '../tls/tls.service';
import { encryptJson, decryptJson } from '../../connectors/crypto';
import { setActiveDkim } from '../../mail/mailer';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const norm = (d: string) => String(d ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

/**
 * Complete domain management — HTTPS (Let's Encrypt, delegated to TlsService) AND email sending
 * (DKIM keypair + SPF + DMARC, with DNS verification and live DKIM signing wired into the mailer).
 */
@Injectable()
export class DomainsService implements OnModuleInit {
  private readonly log = new Logger('Domains');
  constructor(private readonly prisma: PrismaService, private readonly tls: TlsService) {}

  /** On boot, push the active verified email domain's DKIM into the mailer so signing survives a restart. */
  async onModuleInit() { await this.refreshActiveDkim().catch(() => undefined); }

  /** Best-effort public IP for the SPF record (the IP MCMF sends mail from). Operators can adjust it. */
  private serverIp(host?: string): string {
    const env = String(process.env.SSO_BASE_URL || '').replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    const h = String(host || '').replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    for (const c of [h, env]) if (/^\d{1,3}(\.\d{1,3}){3}$/.test(c)) return c;
    return env || h || 'YOUR.SERVER.IP';
  }

  private dnsRecords(d: { domain: string; dkimSelector: string; dkimPublic: string | null; emailFrom: string }, serverIp: string) {
    const sel = d.dkimSelector || 'mcmf';
    return {
      dkim: d.dkimPublic ? { type: 'TXT', name: `${sel}._domainkey.${d.domain}`, value: `v=DKIM1; k=rsa; p=${d.dkimPublic}` } : null,
      spf: { type: 'TXT', name: d.domain, value: `v=spf1 ip4:${serverIp} ~all` },
      dmarc: { type: 'TXT', name: `_dmarc.${d.domain}`, value: `v=DMARC1; p=none; rua=mailto:${d.emailFrom || `postmaster@${d.domain}`}` },
    };
  }

  async list(host?: string) {
    const ds = await this.prisma.domain.findMany({ orderBy: { createdAt: 'asc' } });
    const ip = this.serverIp(host);
    return {
      serverIp: ip,
      domains: ds.map((d) => ({
        id: d.id, domain: d.domain,
        httpsEnabled: d.httpsEnabled, certExpiry: d.certExpiry?.toISOString() ?? null,
        emailEnabled: d.emailEnabled, emailVerified: d.emailVerified, emailFrom: d.emailFrom, dkimSelector: d.dkimSelector, active: d.active,
        records: d.emailEnabled ? this.dnsRecords(d, ip) : null,
      })),
    };
  }

  async add(domain: string, host?: string) {
    const dom = norm(domain);
    if (!DOMAIN_RE.test(dom)) throw new BadRequestException('Enter a valid domain like yourco.com (no http://, no path).');
    if (await this.prisma.domain.findUnique({ where: { domain: dom } })) throw new BadRequestException('That domain is already added.');
    await this.prisma.domain.create({ data: { domain: dom } });
    return this.list(host);
  }

  async remove(id: string, host?: string) {
    const d = await this.prisma.domain.findUnique({ where: { id } });
    if (!d) throw new BadRequestException('Domain not found.');
    await this.prisma.domain.delete({ where: { id } });
    if (d.active) await this.refreshActiveDkim();
    return this.list(host);
  }

  // ── Email sending (DKIM) ───────────────────────────────────────────────────────────────────
  /** Generate a DKIM keypair for the domain and return the DKIM + SPF + DMARC records to publish. */
  async setupEmail(id: string, host?: string) {
    const d = await this.prisma.domain.findUnique({ where: { id } });
    if (!d) throw new BadRequestException('Domain not found.');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const dkimPublic = Buffer.from(publicKey).toString('base64'); // SPKI DER, base64 — the DKIM "p=" value
    const emailFrom = d.emailFrom || `notifications@${d.domain}`;
    await this.prisma.domain.update({
      where: { id },
      data: { emailEnabled: true, emailFrom, dkimPublic, dkimPrivate: encryptJson({ pem: privateKey.toString() }), emailVerified: false },
    });
    return this.list(host);
  }

  /** Verify the published DKIM TXT matches, then mark verified + make this the active signing domain. */
  async verifyEmail(id: string, host?: string) {
    const d = await this.prisma.domain.findUnique({ where: { id } });
    if (!d || !d.emailEnabled || !d.dkimPublic) throw new BadRequestException('Set up email (generate the DKIM key) first.');
    const name = `${d.dkimSelector || 'mcmf'}._domainkey.${d.domain}`;
    let txts: string[][];
    try { txts = await dns.resolveTxt(name); } catch { throw new BadRequestException(`No TXT record found at ${name} yet. Add the DKIM record and wait for DNS to propagate, then retry.`); }
    const joined = txts.map((p) => p.join('')).join(' ');
    // The public key is long; matching a solid prefix is enough to confirm the right key is published.
    if (!joined.replace(/\s+/g, '').includes(d.dkimPublic.slice(0, 60))) {
      throw new BadRequestException(`The DKIM TXT at ${name} doesn't match the generated key yet (DNS may still be propagating). Retry in a few minutes.`);
    }
    await this.prisma.domain.update({ where: { id }, data: { emailVerified: true, active: true } });
    await this.prisma.domain.updateMany({ where: { id: { not: id } }, data: { active: false } });
    await this.refreshActiveDkim();
    return this.list(host);
  }

  /** Turn DKIM signing on/off for an already-verified domain (the active sender). */
  async setActive(id: string, active: boolean, host?: string) {
    const d = await this.prisma.domain.findUnique({ where: { id } });
    if (!d || !d.emailVerified) throw new BadRequestException('Verify the domain first.');
    if (active) await this.prisma.domain.updateMany({ where: { id: { not: id } }, data: { active: false } });
    await this.prisma.domain.update({ where: { id }, data: { active } });
    await this.refreshActiveDkim();
    return this.list(host);
  }

  private async refreshActiveDkim() {
    const d = await this.prisma.domain.findFirst({ where: { active: true, emailVerified: true, emailEnabled: true } });
    if (d?.dkimPrivate) {
      try {
        const pem = (decryptJson(d.dkimPrivate) as { pem: string }).pem;
        setActiveDkim({ domain: d.domain, selector: d.dkimSelector || 'mcmf', privateKey: pem, from: d.emailFrom || `notifications@${d.domain}` });
        return;
      } catch (e) { this.log.warn(`active DKIM load failed: ${String((e as Error)?.message ?? e)}`); }
    }
    setActiveDkim(null);
  }

  // ── HTTPS (Let's Encrypt) — delegated to TlsService's ACME engine ───────────────────────────
  async httpsStart(id: string) {
    const d = await this.prisma.domain.findUnique({ where: { id } });
    if (!d) throw new BadRequestException('Domain not found.');
    return this.tls.startDomainCert({ domain: d.domain });
  }

  async httpsValidate(id: string, host?: string) {
    const d = await this.prisma.domain.findUnique({ where: { id } });
    if (!d) throw new BadRequestException('Domain not found.');
    const r = await this.tls.validateDomainCert();
    const expiry = (r as { notAfter?: string | null })?.notAfter;
    await this.prisma.domain.update({ where: { id }, data: { httpsEnabled: true, certExpiry: expiry ? new Date(expiry) : null } });
    return { ...(await this.list(host)), result: r };
  }

  httpsStatus() { return this.tls.domainStatus(); }
  httpsCancel() { return this.tls.cancelDomain(); }

  // ── Platform domain (one per server — no multitenancy) ───────────────────────────────────────
  /** The single public domain this deployment serves on, plus how its HTTPS is provided. */
  async platformStatus(host?: string) {
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } });
    const domain = org?.platformDomain ?? '';
    const mode = org?.platformTlsMode ?? '';
    const cert: any = await this.tls.status().catch(() => ({ present: false }));
    const coversDomain = !!domain && (cert?.cn === domain || (cert?.sans ?? []).includes(domain));
    return {
      serverIp: this.serverIp(host),
      domain, mode,
      cert: { present: !!cert?.present, cn: cert?.cn ?? null, sans: cert?.sans ?? [], selfSigned: !!cert?.selfSigned, daysLeft: cert?.daysLeft ?? null },
      coversDomain,
      httpsLive: !!domain && (mode === 'upstream' || (['letsencrypt', 'upload'].includes(mode) && coversDomain)),
      trusted: mode === 'upstream' ? true : ['letsencrypt', 'upload'].includes(mode) && coversDomain && !cert?.selfSigned,
    };
  }

  private validDomain(domain: string): string {
    const dom = norm(domain);
    if (!DOMAIN_RE.test(dom)) throw new BadRequestException('Enter a valid domain like app.customerco.com (no http://, no path).');
    return dom;
  }
  private async savePlatform(platformDomain: string, platformTlsMode: string) {
    await this.prisma.orgSettings.upsert({ where: { id: 1 }, update: { platformDomain, platformTlsMode }, create: { id: 1, platformDomain, platformTlsMode } });
  }

  /** TLS terminated upstream (load balancer / Cloudflare) — just record the domain. */
  async setPlatformUpstream(domain: string, host?: string) {
    await this.savePlatform(this.validDomain(domain), 'upstream');
    return this.platformStatus(host);
  }

  /** Operator uploads their own cert + key (e.g. wildcard / corporate CA). */
  async uploadPlatformCert(domain: string, certPem: string, keyPem: string, host?: string) {
    const dom = this.validDomain(domain);
    await this.tls.uploadCert(certPem, keyPem);
    await this.savePlatform(dom, 'upload');
    return this.platformStatus(host);
  }

  /** Let's Encrypt: step 1 returns the DNS TXT to publish; step 2 validates + installs. */
  async platformLeStart(domain: string) {
    return this.tls.startDomainCert({ domain: this.validDomain(domain) });
  }
  async platformLeValidate(domain: string, host?: string) {
    const dom = this.validDomain(domain);
    const result = await this.tls.validateDomainCert();
    await this.savePlatform(dom, 'letsencrypt');
    return { ...(await this.platformStatus(host)), result };
  }

  /** Remove the platform domain and revert to a self-signed cert for the server IP. */
  async clearPlatform(host?: string) {
    const ip = this.serverIp(host);
    await this.savePlatform('', '');
    try { if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) await this.tls.regenerate({ cn: ip, sans: [] }); } catch { /* keep current cert if regen fails */ }
    return this.platformStatus(host);
  }
}
