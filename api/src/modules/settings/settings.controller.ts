import { Body, Controller, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SettingsService } from './settings.service';
import { Roles } from '../../auth/roles.decorator';
import { Public } from '../../auth/public.decorator';
import { clientIp } from '../access/access-control.middleware';

@Controller('settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  getAll() {
    return this.service.getAll();
  }

  @Patch()
  update(@Body() body: any) {
    return this.service.update(body ?? {});
  }

  // Maker-checker toggle (admin). Enabling is open; DISABLING requires a fresh 2FA code.
  @Roles('admin')
  @Post('maker-checker')
  setMakerChecker(@Body() body: { enabled?: boolean; code?: string }, @Req() req: any) {
    return this.service.setMakerChecker(req.user?.sub, !!body?.enabled, body?.code ?? '');
  }

  // Environment & Secrets (admin) — infra shown plainly, secrets masked.
  @Roles('admin')
  @Get('environment')
  environment() {
    return this.service.environment();
  }

  // Reveal the full secret values — requires a fresh 2FA code from the requesting admin.
  @Roles('admin')
  @Post('environment/reveal')
  revealEnv(@Body() body: { code?: string }, @Req() req: any) {
    return this.service.revealEnv(req.user?.sub, body?.code ?? '');
  }

  // Network access control — admin only. Returns the caller's IP so they don't block themselves.
  @Roles('admin')
  @Get('blocklist')
  getBlocklist(@Req() req: any) {
    return this.service.getBlocklist(clientIp(req));
  }

  @Roles('admin')
  @Put('blocklist')
  setBlocklist(@Body() body: any) {
    return this.service.setBlocklist(body ?? {});
  }

  // Upload a branding asset (logo / background) — admin only. Returns its URL.
  @Roles('admin')
  @Put('asset')
  uploadAsset(@Body() body: { data?: string; mime?: string }) {
    return this.service.saveAsset(String(body?.data ?? ''), String(body?.mime ?? ''));
  }

  // Serve a branding asset by id — public (loaded via <img src>), cacheable.
  @Public()
  @Get('asset/:id')
  async asset(@Param('id') id: string, @Res() res: Response) {
    const a = await this.service.getAsset(id);
    if (!a) { res.status(404).end(); return; }
    res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': String(a.data.length) });
    res.end(a.data);
  }
}
