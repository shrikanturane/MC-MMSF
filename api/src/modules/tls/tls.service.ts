import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import http from 'node:http';
import * as acme from 'acme-client';
import { encryptJson, decryptJson } from '../../connectors/crypto';

const exec = promisify(execFile);
const CERT_DIR = process.env.TLS_CERT_DIR || '/etc/nginx/certs';
const FULLCHAIN = path.join(CERT_DIR, 'fullchain.pem');
const PRIVKEY = path.join(CERT_DIR, 'privkey.pem');
const ACME_STATE = path.join(CERT_DIR, '.acme-state.enc'); // in-progress Let's Encrypt order (encrypted)
const NGINX = process.env.TLS_NGINX_CONTAINER || 'mcmf-std-nginx';
const SOCK = '/var/run/docker.sock';
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s.trim());

@Injectable()
export class TlsService {
  private readonly log = new Logger('Tls');

  /** Current certificate: subject, SANs, issuer, validity, self-signed? */
  async status() {
    if (!fs.existsSync(FULLCHAIN)) return { present: false };
    try {
      const { stdout } = await exec('openssl', ['x509', '-in', FULLCHAIN, '-noout', '-subject', '-issuer', '-startdate', '-enddate', '-ext', 'subjectAltName']);
      const get = (k: string) => (stdout.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim();
      const subject = get('subject');
      const issuer = get('issuer');
      const notAfter = get('notAfter');
      // openssl prints "X509v3 Subject Alternative Name:\n    DNS:x, IP Address:y" — pull every
      // DNS:/IP Address: token directly (robust to the human-readable header).
      const sans = [...stdout.matchAll(/(?:DNS|IP Address):\s*([^\s,]+)/g)].map((m) => m[1]);
      const expiry = notAfter ? new Date(notAfter) : null;
      const daysLeft = expiry ? Math.round((expiry.getTime() - Date.now()) / 86_400_000) : null;
      return {
        present: true,
        selfSigned: !!subject && subject === issuer,
        subject, issuer, sans,
        hasSan: sans.length > 0,
        notAfter: expiry?.toISOString() ?? null,
        daysLeft,
        cn: get('subject').match(/CN\s*=\s*([^,]+)/)?.[1]?.trim() ?? null,
      };
    } catch (e) {
      this.log.warn(`status: ${String((e as Error)?.message ?? e)}`);
      return { present: true, error: 'could not parse certificate' };
    }
  }

  /** The public certificate PEM (for import / download). */
  certPem() {
    if (!fs.existsSync(FULLCHAIN)) throw new BadRequestException('no certificate present');
    return fs.readFileSync(FULLCHAIN, 'utf8');
  }

  /**
   * Regenerate a self-signed cert with a proper SAN so it can be trusted (green lock once imported).
   * `cn` = primary name; `sans` = additional IPs/domains. localhost is always added.
   */
  async regenerate(body: { cn?: string; sans?: string[] }) {
    const cn = String(body?.cn ?? '').trim();
    if (!cn) throw new BadRequestException('a primary host/domain (CN) is required');
    const entries = [cn, ...(body?.sans ?? []).map((s) => String(s).trim()).filter(Boolean), 'localhost'];
    const sanList = [...new Set(entries)].map((e) => (isIp(e) ? `IP:${e}` : `DNS:${e}`)).join(',');
    const tmpCert = path.join(CERT_DIR, '.new-fullchain.pem');
    const tmpKey = path.join(CERT_DIR, '.new-privkey.pem');
    try {
      await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tmpKey, '-out', tmpCert,
        '-days', '3650', '-subj', `/CN=${cn}/O=MCMF`, '-addext', `subjectAltName=${sanList}`]);
      // sanity-check the new cert parses
      await exec('openssl', ['x509', '-in', tmpCert, '-noout', '-subject']);
      // backup current, swap in atomically
      const ts = Date.now();
      if (fs.existsSync(FULLCHAIN)) fs.copyFileSync(FULLCHAIN, path.join(CERT_DIR, `fullchain.pem.bak.${ts}`));
      if (fs.existsSync(PRIVKEY)) fs.copyFileSync(PRIVKEY, path.join(CERT_DIR, `privkey.pem.bak.${ts}`));
      fs.renameSync(tmpCert, FULLCHAIN);
      fs.renameSync(tmpKey, PRIVKEY);
    } catch (e) {
      for (const f of [tmpCert, tmpKey]) try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      throw new BadRequestException(`cert generation failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
    const reloaded = await this.reloadNginx();
    return { ok: true, reloaded, ...(await this.status()) };
  }

  /** Graceful nginx reload via the Docker socket (exec `nginx -s reload`). */
  private async reloadNginx(): Promise<boolean> {
    try {
      const created = await this.docker('POST', `/containers/${NGINX}/exec`, { Cmd: ['nginx', '-s', 'reload'], AttachStdout: true, AttachStderr: true });
      const id = (created as any)?.Id;
      if (!id) return false;
      await this.docker('POST', `/exec/${id}/start`, { Detach: false, Tty: false });
      return true;
    } catch (e) {
      this.log.warn(`nginx reload failed: ${String((e as Error)?.message ?? e)}`);
      return false;
    }
  }

  /** Minimal Docker Engine API call over the unix socket. */
  private docker(method: string, urlPath: string, body?: any): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request({ socketPath: SOCK, method, path: urlPath, headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`docker ${res.statusCode}: ${data.slice(0, 200)}`));
          try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** A PowerShell script that installs this cert into the Windows Trusted Root store (run as admin). */
  installScript(host: string) {
    const pem = this.certPem().trim();
    const safeHost = (host || 'mcmf').replace(/[^A-Za-z0-9.\-]/g, '');
    return `# MCMF certificate auto-install (Windows). Right-click → Run with PowerShell (as Administrator).
$ErrorActionPreference = 'Stop'
$pem = @'
${pem}
'@
$path = Join-Path $env:TEMP 'mcmf-${safeHost}.crt'
Set-Content -Path $path -Value $pem -Encoding ascii
Import-Certificate -FilePath $path -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null
Write-Host 'MCMF certificate installed into Trusted Root. Restart your browser, then open https://${safeHost}' -ForegroundColor Green
`;
  }

  /**
   * Install an operator-provided certificate + private key (e.g. a wildcard or corporate-CA cert).
   * Validates that the key matches the cert BEFORE swapping, so a bad upload can never break nginx.
   */
  async uploadCert(certPem: string, keyPem: string) {
    const cert = String(certPem ?? '').trim();
    const key = String(keyPem ?? '').trim();
    if (!/-----BEGIN CERTIFICATE-----/.test(cert)) throw new BadRequestException('Paste the certificate in PEM format (it starts with -----BEGIN CERTIFICATE-----).');
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new BadRequestException('Paste the private key in PEM format (it starts with -----BEGIN PRIVATE KEY-----).');
    const vc = path.join(CERT_DIR, '.verify-cert.pem');
    const vk = path.join(CERT_DIR, '.verify-key.pem');
    try {
      fs.writeFileSync(vc, cert + '\n', { mode: 0o600 });
      fs.writeFileSync(vk, key + '\n', { mode: 0o600 });
      let certPub = '';
      try { certPub = (await exec('openssl', ['x509', '-in', vc, '-noout', '-pubkey'])).stdout.trim(); }
      catch { throw new BadRequestException('The certificate could not be parsed — make sure it is a valid PEM certificate.'); }
      let keyPub = '';
      try { keyPub = (await exec('openssl', ['pkey', '-in', vk, '-pubout'])).stdout.trim(); }
      catch { throw new BadRequestException('The private key could not be read — make sure it is an unencrypted PEM key.'); }
      if (certPub !== keyPub) throw new BadRequestException('The certificate and private key do not match (they are from different key pairs).');
    } finally {
      for (const f of [vc, vk]) try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    await this.applyCert(cert, key);
    return { ok: true, ...(await this.status()) };
  }

  // ── Custom domain via Let's Encrypt (ACME DNS-01) ─────────────────────────────────────────────
  /** Atomically install a cert+key pair (backing up the current one) and reload nginx. Fallback-safe:
   *  on any earlier failure the swap never runs, so the existing cert keeps the site working. */
  private async applyCert(certPem: string, keyPem: string): Promise<void> {
    const tmpCert = path.join(CERT_DIR, '.new-fullchain.pem');
    const tmpKey = path.join(CERT_DIR, '.new-privkey.pem');
    fs.writeFileSync(tmpCert, certPem.trim() + '\n', { mode: 0o644 });
    fs.writeFileSync(tmpKey, keyPem.trim() + '\n', { mode: 0o600 });
    await exec('openssl', ['x509', '-in', tmpCert, '-noout', '-subject']); // sanity: the cert parses
    const ts = Date.now();
    if (fs.existsSync(FULLCHAIN)) fs.copyFileSync(FULLCHAIN, path.join(CERT_DIR, `fullchain.pem.bak.${ts}`));
    if (fs.existsSync(PRIVKEY)) fs.copyFileSync(PRIVKEY, path.join(CERT_DIR, `privkey.pem.bak.${ts}`));
    fs.renameSync(tmpCert, FULLCHAIN);
    fs.renameSync(tmpKey, PRIVKEY);
    await this.reloadNginx();
  }

  private saveAcmeState(s: Record<string, unknown>) { fs.writeFileSync(ACME_STATE, encryptJson(s), { mode: 0o600 }); }
  private loadAcmeState(): any | null { try { return fs.existsSync(ACME_STATE) ? decryptJson(fs.readFileSync(ACME_STATE, 'utf8')) : null; } catch { return null; } }
  private clearAcmeState() { try { fs.rmSync(ACME_STATE, { force: true }); } catch { /* ignore */ } }
  private dir(staging: boolean) { return staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production; }

  /** Step 1: start a Let's Encrypt order for `domain` and return the DNS TXT record the operator must add. */
  async startDomainCert(body: { domain?: string; email?: string; staging?: boolean }) {
    const domain = String(body?.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!DOMAIN_RE.test(domain)) throw new BadRequestException('Enter a valid domain like mcmf.example.com (no http://, no path).');
    const email = String(body?.email ?? '').trim();
    const staging = !!body?.staging;
    try {
      const accountKey = await acme.crypto.createPrivateKey();
      const client = new acme.Client({ directoryUrl: this.dir(staging), accountKey });
      await client.createAccount({ termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}) });
      const order = await client.createOrder({ identifiers: [{ type: 'dns', value: domain }] });
      const authzs = await client.getAuthorizations(order);
      const challenge = authzs[0].challenges.find((c: any) => c.type === 'dns-01');
      if (!challenge) throw new Error("Let's Encrypt did not offer a DNS-01 challenge for this domain.");
      const recordValue = await client.getChallengeKeyAuthorization(challenge);
      const [domainKey, csr] = await acme.crypto.createCsr({ commonName: domain });
      this.saveAcmeState({
        domain, staging, email,
        accountKeyPem: accountKey.toString(), accountUrl: client.getAccountUrl(),
        order, challenge, domainKeyPem: domainKey.toString(), csrPem: csr.toString(),
        recordName: `_acme-challenge.${domain}`, recordValue, createdAt: new Date().toISOString(),
      });
      return { ok: true, domain, staging, recordType: 'TXT', recordName: `_acme-challenge.${domain}`, recordValue };
    } catch (e) {
      this.clearAcmeState();
      throw new BadRequestException(`Could not start the Let's Encrypt order: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
  }

  /** Any in-progress domain order, so the UI can resume the TXT step after a reload. */
  domainStatus() {
    const s = this.loadAcmeState();
    if (!s) return { pending: false };
    return { pending: true, domain: s.domain, staging: !!s.staging, recordType: 'TXT', recordName: s.recordName, recordValue: s.recordValue, createdAt: s.createdAt };
  }

  cancelDomain() { this.clearAcmeState(); return { ok: true }; }

  /** Step 2: TXT added — ask Let's Encrypt to validate, fetch the cert, install + reload. Keeps the old cert on failure. */
  async validateDomainCert() {
    const s = this.loadAcmeState();
    if (!s) throw new BadRequestException('No domain order in progress — add a domain first.');
    try {
      const client = new acme.Client({ directoryUrl: this.dir(!!s.staging), accountKey: s.accountKeyPem, accountUrl: s.accountUrl });
      await client.completeChallenge(s.challenge);
      await client.waitForValidStatus(s.challenge);
      const finalized = await client.finalizeOrder(s.order, s.csrPem);
      const cert = await client.getCertificate(finalized);
      await this.applyCert(cert, s.domainKeyPem);
      this.clearAcmeState();
      return { ok: true, domain: s.domain, ...(await this.status()) };
    } catch (e) {
      // Keep the existing cert — the site stays up; the order is preserved so the operator can retry.
      throw new BadRequestException(`Validation failed: ${String((e as Error)?.message ?? e).slice(0, 300)}. The current certificate is unchanged, so the site keeps working. A TXT record can take a few minutes to propagate — verify it (dig TXT ${s.recordName}), then retry.`);
    }
  }
}
