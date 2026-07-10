import { Controller, Get, Post, Query } from '@nestjs/common';
import { CiemService } from './ciem.service';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

/**
 * CIEM-lite (thesis 6.3/6.4): cloud identities, over-provisioned/unused/drift
 * findings, cross-cloud consistency, and the sandboxed labelled eval. Gated by
 * the security module permission — entitlement data is sensitive.
 */
@RequireModule('security')
@Controller('ciem')
export class CiemController {
  constructor(private readonly service: CiemService) {}

  @Get('identities')
  identities(@Query('source') source?: 'cloud' | 'sandbox') {
    return this.service.identities(source);
  }

  @Get('findings')
  findings(@Query('source') source?: 'cloud' | 'sandbox') {
    return this.service.findings(source);
  }

  @Get('consistency')
  consistency(@Query('source') source?: 'cloud' | 'sandbox') {
    return this.service.consistency(source);
  }

  @Roles('admin')
  @Post('sync')
  sync() {
    return this.service.syncAll();
  }

  @Roles('admin')
  @Post('eval/run')
  evalRun() {
    return this.service.runEval();
  }
}
