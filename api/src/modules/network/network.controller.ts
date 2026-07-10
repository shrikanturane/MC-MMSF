import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { NetworkService } from './network.service';
import { Roles } from '../../auth/roles.decorator';

@Controller('network')
export class NetworkController {
  constructor(private readonly service: NetworkService) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Get('monitoring')
  monitoring() {
    return this.service.monitoring();
  }

  @Get('topology')
  topology() {
    return this.service.topology();
  }

  // Triggers live NSG/SG/firewall fetch — operator+ (default matrix blocks viewers).
  @Post('scan')
  scan() {
    return this.service.scan();
  }

  // Remediate a risky rule — operators are gated for admin approval.
  @Post('remediate')
  remediate(@Body() body: { riskId: string }, @Req() req: any) {
    return this.service.remediate(body?.riskId, req.user);
  }

  // Cloud-aware field schema (auto-populated regions / groups / networks) for the provisioning form.
  @Get('provision/schema')
  provisionSchema(@Query('provider') provider: string, @Query('kind') kind: string, @Query('region') region: string, @Req() req: any) {
    const adminIp = String(req?.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim() || req?.ip || '';
    return this.service.provisionSchema(provider, kind, region, adminIp);
  }

  // Pre-populated permission-grant scripts (identifiers only, no secrets) — admin only.
  @Roles('admin')
  @Get('provision/grant-scripts')
  grantScripts() {
    return this.service.grantScripts();
  }

  // Reveal the real identifiers (account / subscription / project ids) — admin + fresh 2FA code (step-up).
  @Roles('admin')
  @Post('provision/grant-scripts/reveal')
  grantScriptsReveal(@Body() body: { code?: string }, @Req() req: any) {
    return this.service.grantScriptsReveal(req.user?.sub, body?.code ?? '');
  }

  // Advanced cloud-integration status (connection + provisioning enabled) — admin only.
  @Roles('admin')
  @Get('provision/status')
  provisionStatus() {
    return this.service.provisionStatus();
  }

  // Non-destructive provisioning readiness probe (DryRun / permission check) — admin only.
  @Roles('admin')
  @Post('provision/test')
  testProvision(@Body() body: { provider: string }) {
    return this.service.testProvision(body?.provider);
  }

  // Site-to-site VPN status (deployed?, PSK, required rules, deploy scripts) — admin only.
  @Roles('admin')
  @Get('vpn/status')
  vpnStatus() {
    return this.service.vpnStatus();
  }

  // Reachability / port test toward a gateway endpoint — admin only.
  @Roles('admin')
  @Post('vpn/test')
  vpnTest(@Body() body: { host: string; port?: number }) {
    return this.service.vpnTest(body?.host, body?.port);
  }

  // Request network / VPN provisioning → creates a governed approval.
  @Post('provision')
  provision(@Body() body: any, @Req() req: any) {
    return this.service.requestProvision(req.user, body);
  }

  // Request a VM delete → creates a governed approval (executed via the connector once approved).
  @Post('provision/delete')
  deleteVm(@Body() body: any, @Req() req: any) {
    return this.service.requestDeprovision(req.user, body);
  }
}
