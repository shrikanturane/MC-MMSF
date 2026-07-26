import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { UptimeService } from './uptime.service';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

/**
 * Device uptime & SLA reporting. Lives under the Monitoring module because that is where its widgets
 * and drill-down are, so a user who cannot see Monitoring cannot pull an availability report either.
 */
@RequireModule('monitoring')
@Controller('uptime')
export class UptimeController {
  constructor(private readonly service: UptimeService) {}

  /** Fleet SLA rollup — the widget's data. */
  @Get('summary')
  summary(@Query('days') days?: string, @Query('sla') sla?: string) {
    return this.service.summary({ days: days ? Number(days) : undefined, sla: sla ? Number(sla) : undefined });
  }

  /** One row per device: availability, downtime, average hours up per day, SLA verdict. */
  @Get('devices')
  devices(@Query('days') days?: string, @Query('type') type?: string, @Query('sla') sla?: string) {
    return this.service.devices({ days: days ? Number(days) : undefined, type, sla: sla ? Number(sla) : undefined });
  }

  /**
   * Drill-down for one device: per-day hours up and the exact times it was off.
   * The key is "<type>:<id>", which contains a colon, so it is the whole remaining path segment.
   */
  @Get('devices/:type/:id')
  device(
    @Param('type') type: string,
    @Param('id') id: string,
    @Query('days') days?: string,
    @Query('sla') sla?: string,
  ) {
    return this.service.device(`${type}:${id}`, { days: days ? Number(days) : undefined, sla: sla ? Number(sla) : undefined });
  }

  /** The 30-day bar chart: hours on per day, newest last. */
  @Get('devices/:type/:id/days')
  deviceDays(@Param('type') type: string, @Param('id') id: string, @Query('days') days?: string) {
    return this.service.deviceDays(`${type}:${id}`, days ? Number(days) : 30);
  }

  /** One day hour by hour. ?date=YYYY-MM-DD (report timezone); omit for today. */
  @Get('devices/:type/:id/day')
  deviceDay(@Param('type') type: string, @Param('id') id: string, @Query('date') date?: string) {
    return this.service.deviceDay(`${type}:${id}`, date);
  }

  /** Recompute the stored day records. Idempotent — they are derived, never accumulated. */
  @Roles('admin', 'operator')
  @Post('rollup')
  rollup(@Query('days') days?: string) {
    return this.service.rollupDays(days ? Number(days) : 35);
  }

  /** Force a collection pass — used after adding a monitor so its first state lands immediately. */
  @Roles('admin', 'operator')
  @Post('collect')
  collect() {
    return this.service.collect();
  }
}
