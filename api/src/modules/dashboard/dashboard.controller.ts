import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('datasets')
  datasets() {
    return this.service.datasets();
  }

  @Get('layout')
  getLayout(@Query('key') key?: string) {
    return this.service.getLayout(key || 'custom');
  }

  @Put('layout')
  saveLayout(@Body() body: { key?: string; panels?: any[] }) {
    return this.service.saveLayout(body?.key || 'custom', body?.panels ?? []);
  }
}
