import { Controller, Get, Param, Query } from '@nestjs/common';
import { ActivityService } from './activity.service';

@Controller('activity')
export class ActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get()
  list(
    @Query('type') type?: string,
    @Query('severity') severity?: string,
    @Query('provider') provider?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({ type, severity, provider, q, limit: limit ? Number(limit) : undefined });
  }

  @Get('summary')
  summary() {
    return this.service.summary();
  }

  @Get('predictive')
  predictive() {
    return this.service.predictive();
  }

  @Get('siem')
  siem(@Query('limit') limit?: string) {
    return this.service.siem(limit ? Number(limit) : undefined);
  }

  @Get('audit')
  audit(@Query('limit') limit?: string) {
    return this.service.audit(limit ? Number(limit) : undefined);
  }

  @Get('resource/:name')
  resource(@Param('name') name: string) {
    return this.service.resourceTimeline(name);
  }
}
