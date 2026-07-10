import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('approvals')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly service: ApprovalsService) {}

  @Get()
  list(@Req() req: any, @Query('status') status?: string) {
    return this.service.list(req.user, status);
  }

  @Get('policies')
  policies() {
    return this.service.policies();
  }

  @Roles('admin')
  @Post(':id/approve')
  approve(@Param('id') id: string, @Req() req: any) {
    return this.service.approve(id, req.user);
  }

  @Roles('admin')
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() body: { note?: string }, @Req() req: any) {
    return this.service.reject(id, req.user, body?.note);
  }

  // Retry a failed deployment — requester or admin; no re-approval (service enforces ownership).
  @Roles('admin', 'operator')
  @Post(':id/retry')
  retry(@Param('id') id: string, @Req() req: any) {
    return this.service.retry(id, req.user);
  }

  @Roles('admin')
  @Post('policies')
  createPolicy(@Body() body: any) {
    return this.service.createPolicy(body);
  }

  @Roles('admin')
  @Patch('policies/:id')
  setPolicy(@Param('id') id: string, @Body() body: any) {
    return this.service.setPolicy(id, body);
  }

  @Roles('admin')
  @Delete('policies/:id')
  deletePolicy(@Param('id') id: string) {
    return this.service.deletePolicy(id);
  }
}
