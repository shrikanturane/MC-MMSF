import { Module } from '@nestjs/common';
import { ApprovalGate } from './approval-gate.service';

/** Lightweight gate (Prisma-only) — imported by action modules to queue approvals. */
@Module({
  providers: [ApprovalGate],
  exports: [ApprovalGate],
})
export class ApprovalGateModule {}
