import { Module } from '@nestjs/common';
import { AiopsController } from './aiops.controller';
import { AiopsService } from './aiops.service';
import { ValidationService } from './validation.service';
import { AlertingModule } from '../alerting/alerting.module';
import { AiModule } from '../ai/ai.module';

@Module({
  // Alerting: confirmed anomalies dispatch through the engine's channels.
  // Ai: the validation suite drives the real RCA path for seeded incidents.
  imports: [AlertingModule, AiModule],
  controllers: [AiopsController],
  providers: [AiopsService, ValidationService],
})
export class AiopsModule {}
