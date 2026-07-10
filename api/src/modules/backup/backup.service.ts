import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptJson, decryptJson } from '../../connectors/crypto';
import { sealBackup, openBackup } from './backup.crypto';

function tryObj(blob: string): any { try { return decryptJson(blob); } catch { return null; } }
function tryStr(blob: string): string | null { try { return decryptJson<string>(blob); } catch { return null; } }

/**
 * Encrypted export/import of the sensitive config: cloud connections, the credential vault, and
 * notification integrations — with their secrets. Stored secrets are decrypted (from the
 * APP_ENCRYPTION_KEY seal) and re-sealed inside a passphrase-protected backup envelope; restore
 * re-seals them under this deployment's key.
 */
@Injectable()
export class BackupService {
  constructor(private readonly prisma: PrismaService) {}

  async backup(passphrase: string) {
    if (!passphrase || passphrase.length < 8) throw new BadRequestException('a backup passphrase of at least 8 characters is required');
    const connections = (await this.prisma.cloudConnection.findMany()).map((c) => ({ name: c.name, provider: c.provider, accountRef: c.accountRef, currency: c.currency, credentials: tryObj(c.credentials) }));
    const vault = (await this.prisma.vmCredential.findMany()).map((v) => ({ userId: v.userId, host: v.host, protocol: v.protocol, username: v.username, kind: v.kind, label: v.label, password: tryStr(v.password) }));
    const channels = (await this.prisma.notificationChannel.findMany()).map((c) => ({ name: c.name, type: c.type, target: c.target, enabled: c.enabled }));
    const integrations = (await this.prisma.integration.findMany()).map((i) => ({ name: i.name, kind: i.kind, target: i.target, status: i.status }));
    const counts = { connections: connections.length, vault: vault.length, channels: channels.length, integrations: integrations.length };
    const bundle = { source: 'mcmf', exportedAt: new Date().toISOString(), counts, connections, vault, channels, integrations };
    return { file: sealBackup(bundle, passphrase), counts };
  }

  async restore(fileStr: string, passphrase: string) {
    if (!fileStr) throw new BadRequestException('a backup file is required');
    if (!passphrase) throw new BadRequestException('the backup passphrase is required');
    const b = openBackup(fileStr, passphrase);
    const r = { connections: 0, vault: 0, channels: 0, integrations: 0 };

    for (const c of b.connections ?? []) {
      if (!c?.name || !c?.provider || c?.credentials == null) continue;
      const data: any = { name: c.name, provider: c.provider, accountRef: c.accountRef ?? '', currency: c.currency ?? null, credentials: encryptJson(c.credentials), status: 'pending' };
      const existing = await this.prisma.cloudConnection.findFirst({ where: { name: c.name, provider: c.provider } });
      if (existing) await this.prisma.cloudConnection.update({ where: { id: existing.id }, data });
      else await this.prisma.cloudConnection.create({ data });
      r.connections++;
    }
    for (const v of b.vault ?? []) {
      if (!v?.host || !v?.protocol || v?.password == null) continue;
      const sealed = encryptJson(String(v.password));
      await this.prisma.vmCredential.upsert({
        where: { userId_host_protocol: { userId: v.userId ?? '', host: v.host, protocol: v.protocol } },
        update: { username: v.username ?? '', password: sealed, kind: v.kind ?? 'vm', label: v.label ?? '' },
        create: { userId: v.userId ?? '', host: v.host, protocol: v.protocol, username: v.username ?? '', password: sealed, kind: v.kind ?? 'vm', label: v.label ?? '' },
      });
      r.vault++;
    }
    for (const c of b.channels ?? []) {
      if (!c?.type || !c?.target) continue;
      const ex = await this.prisma.notificationChannel.findFirst({ where: { type: c.type, target: c.target } });
      if (!ex) await this.prisma.notificationChannel.create({ data: { name: c.name ?? c.type, type: c.type, target: c.target, enabled: c.enabled !== false } });
      r.channels++;
    }
    for (const i of b.integrations ?? []) {
      if (!i?.kind || !i?.target) continue;
      const ex = await this.prisma.integration.findFirst({ where: { kind: i.kind, target: i.target } });
      if (!ex) await this.prisma.integration.create({ data: { name: i.name ?? i.kind, kind: i.kind, target: i.target, status: (i.status ?? 'disconnected') as any } });
      r.integrations++;
    }
    return { ok: true, restored: r, exportedAt: b.exportedAt ?? null };
  }
}
