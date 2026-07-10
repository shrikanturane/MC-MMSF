import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../../auth/roles.decorator';
import { TlsService } from './tls.service';

/** TLS / certificate management (admin). Read status, regenerate with SAN, download cert + installer. */
@Roles('admin')
@Controller('tls')
export class TlsController {
  constructor(private readonly svc: TlsService) {}

  @Get('status')
  status() {
    return this.svc.status();
  }

  @Post('regenerate')
  regenerate(@Body() body: { cn?: string; sans?: string[] }) {
    return this.svc.regenerate(body ?? {});
  }

  // ── Custom domain via Let's Encrypt (ACME DNS-01) ──
  @Get('domain/status')
  domainStatus() {
    return this.svc.domainStatus();
  }

  // Step 1 — start the order, returns the DNS TXT record to add.
  @Post('domain/start')
  domainStart(@Body() body: { domain?: string; email?: string; staging?: boolean }) {
    return this.svc.startDomainCert(body ?? {});
  }

  // Step 2 — TXT added → validate with Let's Encrypt, fetch + install the real cert (keeps old cert on failure).
  @Post('domain/validate')
  domainValidate() {
    return this.svc.validateDomainCert();
  }

  @Post('domain/cancel')
  domainCancel() {
    return this.svc.cancelDomain();
  }

  // Download the public certificate (.crt) to import into a trust store.
  @Get('cert')
  cert(@Res() res: Response) {
    res.set({ 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="mcmf.crt"' });
    res.send(this.svc.certPem());
  }

  // Download a Windows auto-install script (.ps1) that imports the cert into Trusted Root.
  @Get('install-script')
  installScript(@Query('host') host: string, @Res() res: Response) {
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="mcmf-install-cert.ps1"' });
    res.send(this.svc.installScript(host || ''));
  }
}
