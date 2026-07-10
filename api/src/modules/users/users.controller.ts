import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { AuditService } from '../audit/audit.service';

function actor(req: any) {
  return {
    actorEmail: req.user?.email ?? '',
    actorId: req.user?.sub ?? null,
    ip: (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').toString() || null,
    userAgent: (req.headers['user-agent'] || '').toString() || null,
  };
}

@Controller('users')
export class UsersController {
  constructor(
    private readonly service: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get('roles')
  roles() {
    return this.service.roles();
  }

  @Post()
  async create(@Body() body: any, @Req() req: any) {
    const res = await this.service.create(body);
    await this.audit.record({ action: 'user_created', ...actor(req), targetEmail: body?.email, detail: `role=${body?.role ?? 'viewer'}` });
    return res;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    const res = await this.service.update(id, body);
    await this.audit.record({ action: 'user_updated', ...actor(req), targetEmail: body?.email, detail: `id=${id} ${JSON.stringify(body ?? {})}`.slice(0, 200) });
    return res;
  }

  @Post(':id/password')
  async setPassword(@Param('id') id: string, @Body() body: { password?: string }, @Req() req: any) {
    const res = await this.service.setPassword(id, body?.password);
    await this.audit.record({ action: 'password_changed', ...actor(req), detail: `admin reset id=${id}` });
    return res;
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: any) {
    const res = await this.service.remove(id);
    await this.audit.record({ action: 'user_deleted', ...actor(req), detail: `id=${id}` });
    return res;
  }
}
