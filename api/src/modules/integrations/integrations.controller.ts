import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { Roles } from '../../auth/roles.decorator';

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Roles('admin')
  @Get()
  config() {
    return this.service.getConfig();
  }

  @Roles('admin')
  @Patch()
  update(@Body() body: Record<string, string>) {
    return this.service.update(body ?? {});
  }

  // Last hourly health-check result per integration.
  @Roles('admin')
  @Get('health')
  health() {
    return this.service.health();
  }

  // Manually run the health checks now (also runs hourly in the background).
  @Roles('admin')
  @Post('health/run')
  runHealth() {
    return this.service.runHealthChecks();
  }

  @Roles('admin')
  @Post(':provider/test')
  test(@Param('provider') provider: string, @Body() body: { to?: string }) {
    return this.service.test(provider, body?.to);
  }

  @Roles('admin')
  @Delete(':provider')
  remove(@Param('provider') provider: string) {
    return this.service.remove(provider);
  }
}
