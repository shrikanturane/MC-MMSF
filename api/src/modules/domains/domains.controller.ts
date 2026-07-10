import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { DomainsService } from './domains.service';

/** Domain management (admin): HTTPS (Let's Encrypt) + email sending (DKIM/SPF/DMARC). */
@Roles('admin')
@Controller('domains')
export class DomainsController {
  constructor(private readonly svc: DomainsService) {}

  // ── Platform domain (one per server) — declared before :id routes so "platform" isn't read as an id ──
  @Get('platform')
  platformStatus(@Req() req: any) { return this.svc.platformStatus(req?.headers?.host); }

  @Delete('platform')
  platformClear(@Req() req: any) { return this.svc.clearPlatform(req?.headers?.host); }

  @Post('platform/upstream')
  platformUpstream(@Body() b: { domain?: string }, @Req() req: any) { return this.svc.setPlatformUpstream(b?.domain ?? '', req?.headers?.host); }

  @Post('platform/upload')
  platformUpload(@Body() b: { domain?: string; certPem?: string; keyPem?: string }, @Req() req: any) { return this.svc.uploadPlatformCert(b?.domain ?? '', b?.certPem ?? '', b?.keyPem ?? '', req?.headers?.host); }

  @Post('platform/le/start')
  platformLeStart(@Body() b: { domain?: string }) { return this.svc.platformLeStart(b?.domain ?? ''); }

  @Post('platform/le/validate')
  platformLeValidate(@Body() b: { domain?: string }, @Req() req: any) { return this.svc.platformLeValidate(b?.domain ?? '', req?.headers?.host); }

  @Get()
  list(@Req() req: any) { return this.svc.list(req?.headers?.host); }

  @Post()
  add(@Body() b: { domain?: string }, @Req() req: any) { return this.svc.add(b?.domain ?? '', req?.headers?.host); }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) { return this.svc.remove(id, req?.headers?.host); }

  // ── Email (DKIM) ──
  @Post(':id/email/setup')
  emailSetup(@Param('id') id: string, @Req() req: any) { return this.svc.setupEmail(id, req?.headers?.host); }

  @Post(':id/email/verify')
  emailVerify(@Param('id') id: string, @Req() req: any) { return this.svc.verifyEmail(id, req?.headers?.host); }

  @Post(':id/email/active')
  emailActive(@Param('id') id: string, @Body() b: { active?: boolean }, @Req() req: any) { return this.svc.setActive(id, !!b?.active, req?.headers?.host); }

  // ── HTTPS (Let's Encrypt) ──
  @Get('https/status')
  httpsStatus() { return this.svc.httpsStatus(); }

  @Post('https/cancel')
  httpsCancel() { return this.svc.httpsCancel(); }

  @Post(':id/https/start')
  httpsStart(@Param('id') id: string) { return this.svc.httpsStart(id); }

  @Post(':id/https/validate')
  httpsValidate(@Param('id') id: string, @Req() req: any) { return this.svc.httpsValidate(id, req?.headers?.host); }
}
