import { Module } from '@nestjs/common';
import { AlertingController } from './alerting.controller';
import { AlertingService } from './alerting.service';
import { AlertingEngine } from './alerting.engine';

@Module({
  controllers: [AlertingController],
  providers: [AlertingService, AlertingEngine],
  exports: [AlertingEngine], // aiops uses the engine's channel delivery for confirmed anomalies
})
export class AlertingModule {}
