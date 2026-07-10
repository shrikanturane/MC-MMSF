import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const STATUSES = ['passed', 'failed', 'na'];

/** Seed reflects the user's real Azure Defender posture (failed items map to open findings). */
const SEED: { standard: string; control: string; status: string }[] = [
  // CIS Azure Foundations (representative)
  { standard: 'CIS Benchmark', control: 'Ensure MFA is enabled for all privileged users', status: 'passed' },
  { standard: 'CIS Benchmark', control: 'Ensure security defaults / conditional access is configured', status: 'passed' },
  { standard: 'CIS Benchmark', control: 'Ensure NSGs restrict management ports (RDP/SSH) from the internet', status: 'failed' },
  { standard: 'CIS Benchmark', control: 'Ensure virtual machines have disk encryption enabled', status: 'failed' },
  { standard: 'CIS Benchmark', control: 'Ensure machines periodically check for missing system updates', status: 'failed' },
  { standard: 'CIS Benchmark', control: 'Ensure Microsoft Defender CSPM is enabled', status: 'failed' },
  { standard: 'CIS Benchmark', control: 'Ensure Azure Backup is enabled for virtual machines', status: 'failed' },
  { standard: 'CIS Benchmark', control: 'Ensure email notification for high-severity alerts is set', status: 'failed' },
  { standard: 'CIS Benchmark', control: 'Ensure secure transfer required is enabled on storage accounts', status: 'passed' },
  { standard: 'CIS Benchmark', control: 'Ensure SQL servers have auditing enabled', status: 'passed' },
  { standard: 'CIS Benchmark', control: 'Ensure Key Vault soft-delete & purge protection are enabled', status: 'passed' },
  { standard: 'CIS Benchmark', control: 'Ensure activity log retention is set to 365 days or greater', status: 'passed' },
  // ISO 27001
  { standard: 'ISO 27001', control: 'A.9 Access control policy enforced', status: 'passed' },
  { standard: 'ISO 27001', control: 'A.10 Cryptographic controls (encryption at rest)', status: 'failed' },
  { standard: 'ISO 27001', control: 'A.12 Operations security — logging & monitoring', status: 'passed' },
  { standard: 'ISO 27001', control: 'A.13 Network security controls', status: 'failed' },
  { standard: 'ISO 27001', control: 'A.16 Incident management process', status: 'passed' },
  // PCI DSS
  { standard: 'PCI DSS', control: 'Req 1 — Firewall / network segmentation', status: 'failed' },
  { standard: 'PCI DSS', control: 'Req 3 — Protect stored cardholder data (encryption)', status: 'failed' },
  { standard: 'PCI DSS', control: 'Req 8 — Identify & authenticate access (MFA)', status: 'passed' },
  { standard: 'PCI DSS', control: 'Req 10 — Track & monitor access (audit logs)', status: 'passed' },
];

@Injectable()
export class ComplianceService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const n = await this.prisma.complianceItem.count();
    if (n === 0) {
      await this.prisma.complianceItem.createMany({ data: SEED.map((s, i) => ({ ...s, sort: i })) });
    }
  }

  list(standard?: string) {
    return this.prisma.complianceItem.findMany({ where: standard ? { standard } : {}, orderBy: [{ standard: 'asc' }, { sort: 'asc' }] });
  }

  async standards() {
    const items = await this.prisma.complianceItem.findMany();
    const map = new Map<string, { passed: number; failed: number; na: number }>();
    for (const it of items) {
      const e = map.get(it.standard) ?? { passed: 0, failed: 0, na: 0 };
      (e as any)[it.status] = ((e as any)[it.status] ?? 0) + 1;
      map.set(it.standard, e);
    }
    return [...map.entries()].map(([standard, c]) => {
      const denom = c.passed + c.failed;
      return { standard, passed: c.passed, failed: c.failed, na: c.na, total: c.passed + c.failed + c.na, score: denom ? Math.round((c.passed / denom) * 100) : 100 };
    });
  }

  async create(b: any) {
    if (!b?.standard || !b?.control) throw new BadRequestException('standard and control required');
    const max = await this.prisma.complianceItem.aggregate({ where: { standard: b.standard }, _max: { sort: true } });
    return this.prisma.complianceItem.create({
      data: { standard: b.standard, control: b.control, description: b.description ?? null, status: STATUSES.includes(b.status) ? b.status : 'failed', sort: (max._max.sort ?? 0) + 1 },
    });
  }

  update(id: string, b: any) {
    const data: any = {};
    if (b.control !== undefined) data.control = b.control;
    if (b.description !== undefined) data.description = b.description;
    if (b.status !== undefined && STATUSES.includes(b.status)) data.status = b.status;
    return this.prisma.complianceItem.update({ where: { id }, data });
  }

  remove(id: string) {
    return this.prisma.complianceItem.delete({ where: { id } });
  }
}
