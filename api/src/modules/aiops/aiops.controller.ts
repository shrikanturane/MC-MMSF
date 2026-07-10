import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { AiopsService, type EvalParams } from './aiops.service';
import { ValidationService } from './validation.service';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

/**
 * AIOps anomaly detection (engine v2) + the validation suite. Lives under the AI
 * Engine module (Anomalies/Validation tabs), so access is gated by the 'ai' module
 * permission. Confirm is the human approval gate — external notifications fire
 * only from there.
 */
@RequireModule('ai')
@Controller('aiops')
export class AiopsController {
  constructor(
    private readonly service: AiopsService,
    private readonly validation: ValidationService,
  ) {}

  @Get('anomalies')
  anomalies(
    @Query('detector') detector?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.feed({ detector, status, source, limit: limit ? Number(limit) : undefined });
  }

  @Roles('admin', 'operator')
  @Post('anomalies/:id/confirm')
  confirm(@Param('id') id: string, @Req() req: any) {
    return this.service.confirm(id, req.user ?? {});
  }

  @Roles('admin', 'operator')
  @Post('anomalies/:id/dismiss')
  dismiss(@Param('id') id: string, @Req() req: any) {
    return this.service.dismiss(id, req.user ?? {});
  }

  @Get('quality')
  quality() {
    return this.service.quality();
  }

  @Roles('admin', 'operator')
  @Post('scan')
  scan() {
    return this.service.scan({ source: 'live' });
  }

  // ── Suppression windows (declared legitimate load — thesis 2.4) ────────────

  @Get('suppressions')
  suppressions() {
    return this.service.getSuppressions();
  }

  @Roles('admin')
  @Put('suppressions')
  setSuppressions(@Body() body: unknown) {
    return this.service.setSuppressions(Array.isArray(body) ? body : (body as any)?.windows);
  }

  // ── Cross-cloud correlation (thesis 5.3) ───────────────────────────────────

  @Get('correlations')
  correlations(@Query('windowMinutes') windowMinutes?: string) {
    return this.service.correlations(windowMinutes ? Number(windowMinutes) : undefined);
  }

  // ── Validation suite (thesis evidence generators) ─────────────────────────

  @Roles('admin')
  @Post('eval/run')
  evalRun(@Body() body: EvalParams) {
    return this.service.runEvalTrial(body ?? {});
  }

  @Get('eval/latest')
  evalLatest() {
    return this.service.latestEval();
  }

  @Roles('admin')
  @Post('eval/rca')
  evalRca() {
    return this.validation.runRcaEval();
  }

  @Roles('admin')
  @Post('eval/correlation')
  evalCorrelation() {
    return this.validation.runCorrelationEval();
  }

  @Get('validation')
  validationSummary() {
    return this.validation.summary();
  }
}
