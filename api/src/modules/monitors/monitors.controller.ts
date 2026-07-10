import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { MonitorsService } from './monitors.service';

@Controller('monitors')
export class MonitorsController {
  constructor(private readonly service: MonitorsService) {}

  @Get()
  list(@Req() req: any) {
    // Users with assigned monitor groups only see those; everyone else sees all.
    return this.service.listForUser(req.user?.sub);
  }

  @Get('protocols')
  protocols() {
    return this.service.protocols();
  }

  // Network devices (firewall/router/switch) with SNMP-derived telemetry for the widget.
  @Get('network')
  network(@Req() req: any) {
    return this.service.networkDevices(req.user?.sub);
  }

  // Push an immediate SNMP poll of one device → returns SNMP status + refreshed device view.
  @Post(':id/snmp-poll')
  snmpPoll(@Param('id') id: string) {
    return this.service.snmpPollNow(id);
  }

  @Post()
  create(@Body() body: any) {
    return this.service.create(body ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body ?? {});
  }

  @Post('check')
  checkNow() {
    return this.service.checkNow();
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
