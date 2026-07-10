import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptJson, decryptJson } from '../../connectors/crypto';
import { verifyTotp } from '../../auth/totp';
import { AuditService } from '../audit/audit.service';

const KINDS = ['vm', 'firewall', 'router', 'switch', 'network', 'other'];
const PROTOCOLS = ['ssh', 'rdp', 'telnet', 'vnc', 'snmp', 'https', 'other'];

/**
 * Credential Vault — a single encrypted store (VmCredential) for every device password
 * (VMs, firewalls, routers, switches). Passwords are sealed (AES-256-GCM) and only revealed
 * after a TOTP step-up. Console + SSH-pull auto-pick credentials from here by host/IP.
 */
@Injectable()
export class VaultService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** List a user's entries — never returns passwords. */
  async list(userId: string) {
    const rows = await this.prisma.vmCredential.findMany({ where: { userId }, orderBy: [{ kind: 'asc' }, { host: 'asc' }] });
    return rows.map((r) => ({
      id: r.id,
      host: r.host,
      protocol: r.protocol,
      username: r.username,
      kind: r.kind,
      label: r.label,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async upsert(userId: string, b: any) {
    const host = String(b?.host ?? '').trim();
    // Accept one protocol OR several (same username/password applied to each, e.g. RDP + Telnet).
    const protoList: unknown[] = Array.isArray(b?.protocols) && b.protocols.length ? b.protocols : [b?.protocol];
    const protocols: string[] = [...new Set(protoList.map((p) => String(p)).filter((p) => PROTOCOLS.includes(p)))];
    if (protocols.length === 0) protocols.push('ssh');
    const username = String(b?.username ?? '').trim();
    const password = String(b?.password ?? '');
    if (!host || !username || !password) throw new BadRequestException('host, username and password are required');
    const kind = KINDS.includes(b?.kind) ? b.kind : 'vm';
    const label = String(b?.label ?? '').trim();
    const sealed = encryptJson(password);
    for (const protocol of protocols) {
      await this.prisma.vmCredential.upsert({
        where: { userId_host_protocol: { userId, host, protocol } },
        update: { username, password: sealed, kind, label },
        create: { userId, host, protocol, username, password: sealed, kind, label },
      });
    }
    return { ok: true, count: protocols.length };
  }

  async update(userId: string, id: string, b: any) {
    const cred = await this.prisma.vmCredential.findUnique({ where: { id } });
    if (!cred || cred.userId !== userId) throw new BadRequestException('credential not found');
    const data: any = {};
    if (b?.host !== undefined) data.host = String(b.host).trim();
    if (b?.protocol && PROTOCOLS.includes(b.protocol)) data.protocol = b.protocol;
    if (b?.username !== undefined) data.username = String(b.username).trim();
    if (b?.password) data.password = encryptJson(String(b.password)); // blank = keep
    if (b?.kind && KINDS.includes(b.kind)) data.kind = b.kind;
    if (b?.label !== undefined) data.label = String(b.label).trim();
    await this.prisma.vmCredential.update({ where: { id }, data });
    return { ok: true };
  }

  async remove(userId: string, id: string) {
    await this.prisma.vmCredential.deleteMany({ where: { id, userId } });
    return { ok: true };
  }

  /** Reveal a password — requires a valid TOTP code (step-up auth) and 2FA enabled. */
  async reveal(userId: string, id: string, code: string, meta: { ip?: string | null; userAgent?: string | null } = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ForbiddenException('session is no longer valid');
    if (!user.totpEnabled || !user.totpSecret) {
      throw new ForbiddenException('Enable two-factor authentication (Settings → Profile & Security) to open the vault.');
    }
    if (!verifyTotp(user.totpSecret, String(code ?? '').replace(/\s/g, ''))) {
      await this.audit.record({ action: 'vault_reveal_denied', actorEmail: user.email, actorId: user.id, ip: meta.ip, userAgent: meta.userAgent, detail: `bad 2FA code for credential ${id}` }).catch(() => undefined);
      throw new ForbiddenException('Invalid 2FA code.');
    }
    const cred = await this.prisma.vmCredential.findUnique({ where: { id } });
    if (!cred || cred.userId !== userId) throw new BadRequestException('credential not found');
    let password = '';
    try { password = decryptJson<string>(cred.password); } catch { throw new BadRequestException('could not decrypt this credential'); }
    await this.audit.record({ action: 'vault_reveal', actorEmail: user.email, actorId: user.id, ip: meta.ip, userAgent: meta.userAgent, detail: `revealed ${cred.host} / ${cred.protocol}` }).catch(() => undefined);
    return { password, host: cred.host, username: cred.username };
  }
}
