import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { Public } from '../../auth/public.decorator';
import { ReplicationService } from './replication.service';

@Controller('replication')
export class ReplicationController {
  constructor(private readonly service: ReplicationService) {}

  @Get()
  list() {
    return this.service.list();
  }

  // ---- standalone agent ----
  @Roles('admin', 'operator')
  @Post('agent/enroll')
  agentEnroll(@Body() body: any) {
    return this.service.agentEnroll(body ?? {});
  }

  @Public()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Get('agent/script')
  agentScript(@Query('key') key: string, @Query('url') url: string, @Query('os') os: string) {
    return this.service.agentScript(String(key || ''), String(url || ''), String(os || 'linux'));
  }

  @Public()
  @Post('agent/checkin')
  agentCheckin(@Body() body: any, @Req() req: any) {
    return this.service.agentCheckin(body ?? {}, req?.ip || req?.headers?.['x-forwarded-for'] || '');
  }

  @Public()
  @Post('agent/report')
  agentReport(@Body() body: any) {
    return this.service.agentReport(body ?? {});
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
  @Post(':id/run')
  run(@Param('id') id: string, @Body() body: { direction?: 'p2s' | 'p2t' | 's2t' }) {
    return this.service.runNow(id, body?.direction ?? 'p2s');
  }

  @Roles('admin', 'operator')
  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.service.test(id);
  }

  @Roles('admin', 'operator')
  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.service.stop(id);
  }

  @Roles('admin', 'operator')
  @Post(':id/promote')
  promote(@Param('id') id: string, @Body() body: { to?: 'primary' | 'secondary' | 'tertiary' }) {
    return this.service.promote(id, body?.to ?? 'secondary');
  }
}
