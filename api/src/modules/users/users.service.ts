import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';

/** RBAC matrix — what each role may do. Single source of truth for the UI + future enforcement. */
export const ROLE_SPECS: { role: Role; label: string; description: string; permissions: string[] }[] = [
  {
    role: 'admin',
    label: 'Administrator',
    description: 'Full control — manage users, clouds, settings and billing.',
    permissions: [
      'Manage users & roles',
      'Manage cloud connections',
      'Control VMs (start/stop/reboot)',
      'Edit alert rules & automation',
      'Edit settings, branding & billing',
      'View everything',
    ],
  },
  {
    role: 'operator',
    label: 'Operator',
    description: 'Run day-to-day cloud operations. No user or billing administration.',
    permissions: [
      'Manage cloud connections',
      'Control VMs (start/stop/reboot)',
      'Edit alert rules & automation',
      'Acknowledge / resolve alerts',
      'View everything',
    ],
  },
  {
    role: 'viewer',
    label: 'Viewer',
    description: 'Read-only access to dashboards, inventory and reports.',
    permissions: ['View dashboards & inventory', 'View alerts & findings', 'View cost & compliance'],
  },
];

const ROLES = new Set<Role>(['admin', 'operator', 'viewer']);

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = (stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger('Users');
  constructor(private readonly prisma: PrismaService) {}

  /** Seed a first admin from the org profile so the account is never empty. */
  async onModuleInit() {
    const count = await this.prisma.user.count();
    if (count > 0) return;
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } });
    await this.prisma.user.create({
      data: {
        name: org?.userName || 'Administrator',
        email: org?.userEmail || 'admin@mcmf.local',
        contact: '',
        role: 'admin',
        status: 'active',
        passwordHash: hashPassword('Admin@123'),
      },
    });
    this.logger.log('seeded default admin (password: Admin@123 — change it)');
  }

  roles() {
    return ROLE_SPECS;
  }

  async list() {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    // Never return the password hash.
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      contact: u.contact,
      role: u.role,
      status: u.status,
      monitorGroups: Array.isArray(u.monitorGroups) ? (u.monitorGroups as string[]) : [],
      twoFactorEnabled: (u as any).totpEnabled ?? false,
      require2fa: (u as any).require2fa ?? false,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  /** Sanitize an incoming monitor-group list ([] = all groups). */
  private cleanGroups(v: unknown): string[] {
    return Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : [];
  }

  private validRole(role: unknown): Role {
    if (!ROLES.has(role as Role)) throw new BadRequestException(`role must be one of: ${[...ROLES].join(', ')}`);
    return role as Role;
  }

  async create(body: { name?: string; email?: string; contact?: string; role?: string; password?: string; status?: string; monitorGroups?: unknown; groupId?: string }) {
    if (!body.name?.trim()) throw new BadRequestException('name is required');
    if (!body.email?.trim()) throw new BadRequestException('email is required');
    if (!body.password || body.password.length < 6) throw new BadRequestException('password must be at least 6 characters');
    const role = this.validRole(body.role ?? 'viewer');
    // Group is mandatory so a new user is never left with no access (the strict no-group default).
    const groupId = String(body.groupId ?? '').trim();
    if (!groupId) throw new BadRequestException('an access group is required');
    const group = await this.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new BadRequestException('the selected access group no longer exists');
    const email = body.email.trim().toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('a user with that email already exists');
    const u = await this.prisma.user.create({
      data: {
        name: body.name.trim(),
        email,
        contact: body.contact?.trim() ?? '',
        role,
        status: body.status === 'suspended' ? 'suspended' : 'active',
        passwordHash: hashPassword(body.password),
        monitorGroups: this.cleanGroups(body.monitorGroups),
      },
    });
    await this.prisma.groupMembership.create({ data: { groupId, userId: u.id } }).catch(() => undefined);
    return { id: u.id };
  }

  async update(id: string, body: { name?: string; email?: string; contact?: string; role?: string; status?: string; monitorGroups?: unknown; require2fa?: boolean }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    const data: any = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.contact !== undefined) data.contact = body.contact.trim();
    if (body.status !== undefined) data.status = body.status === 'suspended' ? 'suspended' : 'active';
    if (body.monitorGroups !== undefined) data.monitorGroups = this.cleanGroups(body.monitorGroups);
    if (body.require2fa !== undefined) data.require2fa = !!body.require2fa;
    if (body.role !== undefined) {
      const role = this.validRole(body.role);
      // Don't allow demoting the last admin — keeps at least one full-access account.
      if (user.role === 'admin' && role !== 'admin') await this.assertNotLastAdmin(id);
      data.role = role;
    }
    if (body.email !== undefined) {
      const email = body.email.trim().toLowerCase();
      const clash = await this.prisma.user.findFirst({ where: { email, NOT: { id } } });
      if (clash) throw new ConflictException('a user with that email already exists');
      data.email = email;
    }
    await this.prisma.user.update({ where: { id }, data });
    return { ok: true };
  }

  async setPassword(id: string, password?: string) {
    if (!password || password.length < 6) throw new BadRequestException('password must be at least 6 characters');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    await this.prisma.user.update({ where: { id }, data: { passwordHash: hashPassword(password) } });
    return { ok: true };
  }

  async remove(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    if (user.role === 'admin') await this.assertNotLastAdmin(id);
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }

  private async assertNotLastAdmin(excludeId: string) {
    const otherAdmins = await this.prisma.user.count({ where: { role: 'admin', status: 'active', NOT: { id: excludeId } } });
    if (otherAdmins === 0) throw new BadRequestException('cannot remove the last active administrator');
  }
}
