import { Body, Controller, Delete, Get, Post, Query, Req } from '@nestjs/common';
import { ConsoleService } from './console.service';
import { Roles } from '../../auth/roles.decorator';

@Controller('console')
export class ConsoleController {
  constructor(private readonly service: ConsoleService) {}

  // Saved-credential status (no password returned) — the caller's own vault entry.
  @Roles('admin', 'operator')
  @Get('cred')
  getCred(@Query('host') host: string, @Query('protocol') protocol: string, @Req() req: any) {
    return this.service.getCred(req.user?.sub, host, protocol);
  }

  @Roles('admin', 'operator')
  @Post('cred')
  setCred(@Body() body: any, @Req() req: any) {
    return this.service.setCred(req.user?.sub, body ?? {});
  }

  @Roles('admin', 'operator')
  @Delete('cred')
  deleteCred(@Query('host') host: string, @Query('protocol') protocol: string, @Req() req: any) {
    return this.service.deleteCred(req.user?.sub, host, protocol);
  }

  // Mint a Guacamole connection token for an in-browser RDP/SSH/telnet session.
  @Roles('admin', 'operator')
  @Post('token')
  token(@Body() body: any, @Req() req: any) {
    return this.service.token(req.user?.sub, body ?? {});
  }

  // Pre-connect TCP reachability probe (server → VM console port).
  @Roles('admin', 'operator')
  @Post('check')
  check(@Body() body: any) {
    return this.service.check(body ?? {});
  }
}
