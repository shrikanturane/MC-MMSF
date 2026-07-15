import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { OptimizationService } from './optimization.service';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

/**
 * Layer 12 — Continuous Feedback & Optimisation. The Optimisation panel lives on the Command Center page,
 * so access is gated by the 'commandCenter' module permission (same convention as AiopsController, which
 * gates on 'ai' because its tabs live under the AI Engine page). Apply is admin-only: it writes back into
 * policy/alert/workflow config.
 */
@RequireModule('commandCenter')
@Controller('optimization')
export class OptimizationController {
  constructor(private readonly service: OptimizationService) {}

  @Get('insights')
  insights(@Query('status') status?: string) {
    return this.service.list(status);
  }

  @Roles('admin', 'operator')
  @Post('generate')
  generate() {
    return this.service.generate();
  }

  @Roles('admin')
  @Post(':id/apply')
  apply(@Param('id') id: string, @Req() req: any) {
    return this.service.apply(id, req.user ?? {});
  }

  @Roles('admin', 'operator')
  @Post(':id/dismiss')
  dismiss(@Param('id') id: string) {
    return this.service.dismiss(id);
  }
}
