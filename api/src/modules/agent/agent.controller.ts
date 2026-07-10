import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AgentService } from './agent.service';
import { Public } from '../../auth/public.decorator';
import { Roles } from '../../auth/roles.decorator';

@Controller('agent')
export class AgentController {
  constructor(private readonly service: AgentService) {}

  // Machine-to-machine ingest: authenticated by the x-agent-key header, not a user JWT.
  @Public()
  @Post('ingest')
  async ingest(@Headers('x-agent-key') key: string, @Body() body: any) {
    await this.service.assertKeyOrToken(key);
    return this.service.ingest(body ?? {});
  }

  // ── Outbound command channel (agent dials home over HTTPS — no inbound ports) ──
  // Agent long-polls for queued commands (key-authenticated). Held ~25s server-side.
  // Prefer the x-agent-key HEADER (keeps the key out of access logs); the ?k= query stays
  // supported so already-enrolled agents don't break.
  @Public()
  @Get('commands')
  longPoll(@Query('agentId') agentId: string, @Query('k') k: string, @Headers('x-agent-key') hk: string, @Headers('host') host: string) {
    return this.service.longPollCommands(agentId, hk || k, host);
  }

  // Agent posts a command result back over the same outbound channel.
  @Public()
  @Post('command-result')
  commandResult(@Headers('x-agent-key') key: string, @Body() body: any) {
    return this.service.commandResult(key, body ?? {});
  }

  // Admin: queue a command for an outbound agent (run | power | config | update).
  @Roles('admin')
  @Post(':id/command')
  enqueueCommand(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.enqueueCommand(req.user?.sub, id, body ?? {});
  }

  // Admin/operator: recent command history for an agent.
  @Roles('admin', 'operator')
  @Get(':id/commands')
  listCommands(@Param('id') id: string) {
    return this.service.listCommands(id);
  }

  // Admin: shut down + remove an agent — it uninstalls itself (service + files) and drops off.
  @Roles('admin')
  @Post(':id/shutdown')
  shutdown(@Param('id') id: string, @Req() req: any) {
    return this.service.shutdownAgent(req.user?.sub, id);
  }

  @Roles('admin', 'operator')
  @Get()
  list() {
    return this.service.list();
  }

  @Roles('admin', 'operator')
  @Get('os-inventory')
  osInventory() {
    return this.service.osInventory();
  }

  // Pre-filled install scripts (key + URL baked in) — admin only. The agent is bound to the host the
  // request arrived on (download from production → agent targets production).
  @Roles('admin')
  @Get('install')
  install(@Headers('host') host: string) {
    return this.service.install(host);
  }

  // Zero-dependency bootstrap script for a fresh Windows box — served only to holders of the
  // agent key (the admin gets the full one-liner, with key, from the admin-only command below).
  @Public()
  @Get('bootstrap')
  bootstrap(@Query('k') k: string, @Headers('host') host: string, @Res() res: Response) {
    this.service.assertKey(k);
    res.set({ 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(this.service.windowsBootstrap(host));
  }

  // Admin: the copy-paste one-liner (cert-bypass + download + run) for fresh Windows enrollment.
  @Roles('admin')
  @Get('bootstrap-command')
  bootstrapCommand(@Headers('host') host: string) {
    return this.service.windowsBootstrapOneLiner(host);
  }

  // Pure-outbound Linux agent program — served to holders of the agent key (for install + self-update).
  @Public()
  @Get('linux')
  linuxAgent(@Query('k') k: string, @Headers('host') host: string, @Res() res: Response) {
    this.service.assertKey(k);
    res.set({ 'Content-Type': 'text/x-python; charset=utf-8' });
    res.end(this.service.linuxAgent(host));
  }

  // One-shot Linux installer (curl … | sudo bash) — key-authenticated, runs on a host with no JWT.
  @Public()
  @Get('linux-install')
  linuxInstall(@Query('k') k: string, @Headers('host') host: string, @Res() res: Response) {
    this.service.assertKey(k);
    res.set({ 'Content-Type': 'text/x-shellscript; charset=utf-8' });
    res.end(this.service.linuxInstallScript(host));
  }

  // Admin: the copy-paste Linux install one-liner for the UI.
  @Roles('admin')
  @Get('linux-command')
  linuxCommand(@Headers('host') host: string) {
    return this.service.linuxInstallOneLiner(host);
  }

  // Build + download the Windows endpoint-agent installer (.exe) — admin only.
  @Roles('admin')
  @Get('windows-installer')
  async windowsInstaller(@Headers('host') host: string, @Res() res: Response) {
    const exe = await this.service.windowsInstaller(host);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="MCMF-Agent-Setup.exe"',
      'Content-Length': String(exe.length),
    });
    res.end(exe);
  }

  // Same installer wrapped in a .zip — avoids the browser's "unsafe .exe download" warning.
  @Roles('admin')
  @Get('windows-installer-zip')
  async windowsInstallerZip(@Headers('host') host: string, @Res() res: Response) {
    const zip = await this.service.windowsInstallerZip(host);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="MCMF-Agent-Setup.zip"',
      'Content-Length': String(zip.length),
    });
    res.end(zip);
  }

  // Admin: enroll an agentless SSH-pull target (MCMF connects out to the VM and collects).
  @Roles('admin')
  @Post('pull')
  enrollPull(@Body() body: any, @Req() req: any) {
    return this.service.enrollPull(req.user?.sub, body ?? {});
  }

  // Admin/operator: pull this VM's telemetry now (per-VM Services Monitoring "Pull now").
  @Roles('admin', 'operator')
  @Post(':id/pull-now')
  pullNow(@Param('id') id: string) {
    return this.service.pullNow(id);
  }

  // Admin: remotely push-install the guest agent on a Linux target over SSH (stored creds),
  // then pull from it. Converts the target to an installed TCP agent when reachable.
  @Roles('admin')
  @Post(':id/push-agent')
  pushAgent(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.pushAgent(req.user?.sub, id, body ?? {});
  }

  // Admin: change reporting interval, or decommission (active:false → agent self-exits).
  @Roles('admin')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body ?? {});
  }

  // Admin: remove an agent (exit requires an administrator).
  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
