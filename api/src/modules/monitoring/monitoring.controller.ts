import { Controller, Get, Query } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';

@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly service: MonitoringService) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Get('timeseries')
  timeseries(@Query('metric') metric?: string, @Query('vm') vm?: string) {
    const m = ['cpu', 'memory', 'disk', 'network', 'latency', 'jitter', 'error'].includes(metric ?? '') ? (metric as string) : 'cpu';
    return this.service.timeseries(m, vm);
  }

  @Get('incidents')
  incidents() {
    return this.service.incidents();
  }

  @Get('telemetry')
  telemetry() {
    return this.service.telemetry();
  }

  @Get('events')
  events(@Query('limit') limit?: string) {
    return this.service.events(limit ? Number(limit) : 60);
  }
}
