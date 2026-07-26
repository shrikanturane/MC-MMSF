import { Module } from '@nestjs/common';
import { UptimeController } from './uptime.controller';
import { UptimeService } from './uptime.service';

@Module({
  controllers: [UptimeController],
  providers: [UptimeService],
})
export class UptimeModule {}
