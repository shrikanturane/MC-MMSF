import { Module } from '@nestjs/common';
import { OptimizationController } from './optimization.controller';
import { OptimizationService } from './optimization.service';
import { AiopsModule } from '../aiops/aiops.module';
import { PoliciesModule } from '../policies/policies.module';
import { AlertingModule } from '../alerting/alerting.module';

@Module({
  // Layer 12 reads the signal these three layers produce and writes its approved changes back through
  // their own services, so their validation runs rather than being bypassed with raw Prisma writes.
  imports: [AiopsModule, PoliciesModule, AlertingModule],
  controllers: [OptimizationController],
  providers: [OptimizationService],
})
export class OptimizationModule {}
