import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const VIA = ['email', 'whatsapp', 'both'];

/** Coerce a stored access blob into a stable, fully-populated shape for the client. */
export function normalizeAccess(a: any): { governs: boolean; all: boolean; modules: string[]; widgets: string[]; help: string[]; pages: string[] } {
  const arr = (v: any) => (Array.isArray(v) ? v.map(String) : []);
  return { governs: !!a?.governs, all: !!a?.all, modules: arr(a?.modules), widgets: arr(a?.widgets), help: arr(a?.help), pages: arr(a?.pages) };
}

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const groups = await this.prisma.group.findMany({
      orderBy: { name: 'asc' },
      include: { members: { include: { user: { select: { id: true, name: true, email: true, contact: true } } } } },
    });
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      notifyVia: g.notifyVia,
      access: normalizeAccess((g as any).access),
      memberCount: g.members.length,
      members: g.members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, contact: m.user.contact })),
    }));
  }

  async create(body: { name?: string; description?: string; notifyVia?: string }) {
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    const g = await this.prisma.group.create({
      data: { name: body.name.trim(), description: body.description ?? '', notifyVia: VIA.includes(body.notifyVia ?? '') ? body.notifyVia! : 'email' },
    });
    return { id: g.id };
  }

  async update(id: string, body: { name?: string; description?: string; notifyVia?: string; access?: any }) {
    const data: any = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.description !== undefined) data.description = body.description;
    if (body.notifyVia !== undefined && VIA.includes(body.notifyVia)) data.notifyVia = body.notifyVia;
    if (body.access !== undefined) data.access = normalizeAccess(body.access);
    await this.prisma.group.update({ where: { id }, data });
    return { ok: true };
  }

  async remove(id: string) {
    await this.prisma.group.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('group not found');
    });
    return { ok: true };
  }

  async addMember(groupId: string, userId: string) {
    if (!userId) throw new BadRequestException('userId required');
    await this.prisma.groupMembership.upsert({
      where: { groupId_userId: { groupId, userId } },
      update: {},
      create: { groupId, userId },
    });
    return { ok: true };
  }

  async removeMember(groupId: string, userId: string) {
    await this.prisma.groupMembership.deleteMany({ where: { groupId, userId } });
    return { ok: true };
  }
}
