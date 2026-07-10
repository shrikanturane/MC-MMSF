import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { VaultService } from './vault.service';

// Per-user vault — every authenticated user manages their OWN credentials.
@Controller('vault')
export class VaultController {
  constructor(private readonly service: VaultService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.list(req.user?.sub);
  }

  @Post()
  upsert(@Body() body: any, @Req() req: any) {
    return this.service.upsert(req.user?.sub, body ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.update(req.user?.sub, id, body ?? {});
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.service.remove(req.user?.sub, id);
  }

  // Step-up: reveal a password only with a valid TOTP code.
  @Post(':id/reveal')
  reveal(@Param('id') id: string, @Body() body: { code?: string }, @Req() req: any) {
    return this.service.reveal(req.user?.sub, id, body?.code ?? '', { ip: req.ip, userAgent: req.headers?.['user-agent'] });
  }
}
