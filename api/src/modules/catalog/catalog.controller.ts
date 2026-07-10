import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';
import { CatalogService } from './catalog.service';

/** Service Catalog — Terraform-engine provisioning across AWS/Azure/GCP (+ a credential-free demo). */
@RequireModule('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get()
  catalog() { return this.svc.catalog(); }

  @Get('jobs')
  jobs() { return this.svc.jobs(); }

  @Get('jobs/:id')
  job(@Param('id') id: string) { return this.svc.job(id); }

  @Post('plan')
  @Roles('admin', 'operator')
  plan(@Body() b: any, @Req() req: any) { return this.svc.plan(b, req?.user?.email ?? ''); }

  @Post('jobs/:id/apply')
  @Roles('admin', 'operator')
  apply(@Param('id') id: string, @Req() req: any) { return this.svc.apply(id, req?.user?.email ?? ''); }

  @Post('jobs/:id/destroy')
  @Roles('admin')
  destroy(@Param('id') id: string, @Req() req: any) { return this.svc.destroy(id, req?.user?.email ?? ''); }
}
