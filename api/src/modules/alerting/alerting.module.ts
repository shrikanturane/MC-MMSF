import { Module } from '@nestjs/common';
import { AlertingController } from './alerting.controller';
import { AlertingService } from './alerting.service';
import { AlertingEngine } from './alerting.engine';

@Module({
  controllers: [AlertingController],
  providers: [AlertingService, AlertingEngine],
  // aiops uses the engine's channel delivery for confirmed anomalies; optimization (Layer 12) reads
  // rules/workflows and creates approved ones through the service so its validation runs.
  exports: [AlertingEngine, AlertingService],
})
export class AlertingModule {}
