import { Controller, Get, Post, Query } from '@nestjs/common';
import { SecurityService } from './security.service';
import { VaptScanner } from './vapt.scanner';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('security')
@Controller('security')
export class SecurityController {
  constructor(
    private readonly service: SecurityService,
    private readonly vapt: VaptScanner,
  ) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Post('refresh')
  refresh() {
    return this.service.refreshFindings();
  }

  // External VAPT: open-source Nmap scan of every enrolled VM → vuln/misconfig/threat findings.
  @Post('vapt')
  runVapt() {
    return this.vapt.start();
  }

  @Get('vapt/status')
  vaptStatus() {
    return { scanning: this.vapt.isScanning() };
  }

  // The scan ruleset + compliance process — what external VAPT checks and how to remediate.
  @Get('vapt/rules')
  vaptRules() {
    return VaptScanner.ruleset();
  }

  @Get('findings')
  findings(
    @Query('type') type?: string,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
  ) {
    return this.service.findings({ type, severity, status });
  }
}
