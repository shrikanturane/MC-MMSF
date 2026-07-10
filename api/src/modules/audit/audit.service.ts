import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntryInput {
  action: string;
  actorEmail?: string;
  actorId?: string | null;
  targetEmail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort — auditing must never break the action it records. */
  async record(e: AuditEntryInput) {
    await this.prisma.auditLog
      .create({
        data: {
          action: e.action,
          actorEmail: e.actorEmail ?? '',
          actorId: e.actorId ?? null,
          targetEmail: e.targetEmail ?? null,
          ip: e.ip ?? null,
          userAgent: e.userAgent ?? null,
          detail: e.detail ?? null,
        },
      })
      .catch(() => undefined);
  }

  async list(params: { action?: string; limit?: number }) {
    const rows = await this.prisma.auditLog.findMany({
      where: params.action ? { action: params.action } : undefined,
      orderBy: { ts: 'desc' },
      take: Math.min(params.limit ?? 100, 500),
    });
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      action: r.action,
      actorEmail: r.actorEmail,
      targetEmail: r.targetEmail,
      ip: r.ip,
      userAgent: r.userAgent,
      detail: r.detail,
    }));
  }
}
