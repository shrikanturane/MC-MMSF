import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { ApiKeyService } from './api-key.service';

/** Admin management of open-API keys (JWT-protected, admin only). */
@Roles('admin')
@Controller('integration/keys')
export class ApiKeysController {
  constructor(private readonly svc: ApiKeyService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() body: { name?: string; scopes?: string[] }, @Req() req: any) {
    return this.svc.create(body?.name ?? '', body?.scopes ?? [], req.user?.sub);
  }

  @Delete(':id')
  revoke(@Param('id') id: string) {
    return this.svc.revoke(id);
  }
}
