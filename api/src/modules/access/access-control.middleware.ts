import { Injectable, NestMiddleware } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// Offline GeoIP (bundled country DB). Lazy-required so a missing package never breaks the API —
// country rules just become inert until geoip-lite is installed.
let geoip: any = null;
try { geoip = require('geoip-lite'); } catch { /* country enforcement disabled */ }

/** Look up the 2-letter country for a public IP. Private/loopback IPs return null (never country-blocked). */
export function countryOf(ip: string): string | null {
  if (!geoip) return null;
  const v = normalizeIp(ip);
  if (!v || /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v)) return null;
  try { return geoip.lookup(v)?.country ?? null; } catch { return null; }
}

/** Strip IPv4-mapped IPv6 prefix and whitespace. */
export function normalizeIp(ip: string): string {
  return (ip || '').replace(/^::ffff:/i, '').trim();
}

export function ipToInt(ip: string): number | null {
  const m = normalizeIp(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return null;
  return (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}

function inCidr(ipInt: number, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const netInt = ipToInt(net);
  if (netInt == null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
}

/** Does this client IP match any enabled blocklist entry? IP / CIDR / range (IPv4). */
export function isBlocked(ipStr: string, entries: any[]): boolean {
  const ip = normalizeIp(ipStr);
  const ipInt = ipToInt(ip);
  for (const e of entries || []) {
    if (!e || e.enabled === false) continue;
    const val = String(e.value || '').trim();
    if (!val) continue;
    if (e.type === 'ip' && val === ip) return true;
    if (e.type === 'cidr' && ipInt != null && inCidr(ipInt, val)) return true;
    if (e.type === 'range') {
      const [a, b] = val.split('-').map((s: string) => ipToInt(s.trim()));
      if (ipInt != null && a != null && b != null && ipInt >= Math.min(a, b) && ipInt <= Math.max(a, b)) return true;
    }
    // type 'country' is stored but not enforced yet (needs a GeoIP feed) — skipped.
  }
  return false;
}

export function clientIp(req: any): string {
  const xff = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return normalizeIp(xff || req?.ip || req?.socket?.remoteAddress || '');
}

/**
 * Network access control: 403s requests from blocked IPs / subnets / ranges. The blocklist lives in
 * OrgSettings and is cached briefly so this stays cheap on every request.
 */
@Injectable()
export class AccessControlMiddleware implements NestMiddleware {
  private cache: { at: number; enabled: boolean; entries: any[]; countryMode: string; countryList: string[] } =
    { at: 0, enabled: false, entries: [], countryMode: 'off', countryList: [] };
  constructor(private readonly prisma: PrismaService) {}

  async use(req: any, res: any, next: () => void) {
    try {
      const now = Date.now();
      if (now - this.cache.at > 15_000) {
        const s: any = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
        this.cache = {
          at: now,
          enabled: !!s?.blocklistEnabled,
          entries: Array.isArray(s?.accessBlocklist) ? s.accessBlocklist : [],
          countryMode: s?.countryMode ?? 'off',
          countryList: Array.isArray(s?.countryList) ? s.countryList.map((c: string) => String(c).toUpperCase()) : [],
        };
      }
      const ip = clientIp(req);
      // IP / CIDR / range blocklist
      if (this.cache.enabled && ip && isBlocked(ip, this.cache.entries)) {
        res.status(403).json({ statusCode: 403, message: 'Access from your network has been blocked by the administrator.' });
        return;
      }
      // Country allow/block (public IPs only — LAN/private IPs are never country-blocked)
      if (this.cache.countryMode !== 'off' && this.cache.countryList.length) {
        const cc = countryOf(ip);
        if (cc) {
          const listed = this.cache.countryList.includes(cc);
          const deny = this.cache.countryMode === 'allow' ? !listed : listed;
          if (deny) {
            res.status(403).json({ statusCode: 403, message: `Access from your country (${cc}) is not permitted.` });
            return;
          }
        }
      }
    } catch {
      /* never let access-control errors take the API down — fail open */
    }
    next();
  }
}
