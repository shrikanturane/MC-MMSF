import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ZeroTrustService } from './zerotrust.service';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('security')
@Controller('zerotrust')
export class ZeroTrustController {
  constructor(private readonly service: ZeroTrustService) {}

  @Get('posture')
  posture() {
    return this.service.posture();
  }

  // Per-VM workload posture coverage — powers the Workload pillar drill-down dashboard.
  @Get('workloads')
  workloads() {
    return this.service.workloads();
  }

  // One-click remediation (network = deny public admin-port / critical rules) — admin only.
  @Roles('admin')
  @Post('remediate')
  remediate(@Body() body: { pillar?: string }, @Req() req: any) {
    return this.service.remediate(body?.pillar ?? '', req.user);
  }
}
