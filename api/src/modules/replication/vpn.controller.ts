import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { VpnService } from './vpn.service';

@Controller('vpn')
export class VpnController {
  constructor(private readonly service: VpnService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get('gateway-types')
  gatewayTypes() {
    return this.service.gatewayTypes();
  }

  @Get('eligible-hosts')
  eligibleHosts() {
    return this.service.eligibleHosts();
  }

  @Post('requirements')
  requirements(@Body() body: any) {
    return this.service.requirements(body ?? {});
  }

  @Post(':id/monitor')
  monitor(@Param('id') id: string) {
    return this.service.monitor(id);
  }

  @Roles('admin', 'operator')
  @Post()
  create(@Body() body: any) {
    return this.service.create(body ?? {});
  }

  @Roles('admin', 'operator')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body ?? {});
  }

  @Roles('admin', 'operator')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Roles('admin', 'operator')
  @Post(':id/up')
  up(@Param('id') id: string) {
    return this.service.up(id);
  }

  @Roles('admin', 'operator')
  @Post(':id/down')
  down(@Param('id') id: string) {
    return this.service.down(id);
  }

  @Post(':id/status')
  status(@Param('id') id: string) {
    return this.service.status(id);
  }
}
