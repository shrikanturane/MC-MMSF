import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AiModule], // AiService → the AI integration "Test" button pings the active provider
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
})
export class IntegrationsModule {}
