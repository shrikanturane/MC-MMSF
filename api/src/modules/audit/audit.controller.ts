import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  // Admin-only — enforced by RbacGuard (path rule).
  @Get()
  list(@Query('action') action?: string, @Query('limit') limit?: string) {
    return this.service.list({ action, limit: limit ? Number(limit) : undefined });
  }
}
