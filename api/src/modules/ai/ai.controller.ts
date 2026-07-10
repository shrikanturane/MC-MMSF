import { Body, Controller, Get, Post } from '@nestjs/common';
import { AiService } from './ai.service';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly service: AiService) {}

  @Get('status')
  status() {
    return this.service.status();
  }

  @Get('health')
  health() {
    return this.service.health();
  }

  @Get('agent-status')
  agentStatus() {
    return this.service.agentStatus();
  }

  // Agentic AI chat — CrewAI agent (local Qwen) with tools over all platform data.
  @Roles('admin', 'operator')
  @Post('chat')
  chat(@Body() body: { message?: string }) {
    return this.service.agentChat(body?.message ?? '');
  }

  @Roles('admin', 'operator')
  @Post('assistant')
  assistant(@Body() body: { prompt?: string }) {
    return this.service.assistant(body?.prompt ?? '');
  }

  @Roles('admin', 'operator')
  @Post('rca')
  rca(@Body() body: { alertId?: string; incidentId?: string }) {
    return this.service.rca(body ?? {});
  }

  // Cross-platform AI analysis & reasoning (fleet | monitoring | security | cost | compliance).
  @Roles('admin', 'operator')
  @Post('analyze')
  analyze(@Body() body: { scope?: string }) {
    return this.service.analyze(body?.scope);
  }

  // AI analysis of the latest VAPT / cloud-security findings (prioritised risk + remediation + summary).
  @Roles('admin', 'operator')
  @Post('vapt-analysis')
  vaptAnalysis() {
    return this.service.vaptAnalysis();
  }

  // AI release notes for a build, inferred from its changed-file list.
  @Roles('admin', 'operator')
  @Post('release-notes')
  releaseNotes(@Body() body: { files?: { p: string; c: string }[]; version?: string }) {
    return this.service.releaseNotes(body ?? {});
  }

  // Tailored AI remediation for a single security finding (per-finding "how to fix").
  @Roles('admin', 'operator')
  @Post('remediation')
  remediation(@Body() body: { title?: string; type?: string; provider?: string; resourceName?: string }) {
    return this.service.remediation(body ?? {});
  }

  // AI decision support for a pending change approval.
  @Roles('admin', 'operator')
  @Post('approval-insight')
  approvalInsight(@Body() body: { id?: string }) {
    return this.service.approvalInsight(body?.id);
  }

  // AI-proposed automation rules from current operational patterns.
  @Roles('admin', 'operator')
  @Get('automation-suggest')
  automationSuggest() {
    return this.service.automationSuggest();
  }
}
