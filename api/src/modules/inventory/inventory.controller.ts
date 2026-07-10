import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InventoryService } from './inventory.service';
import { Roles } from '../../auth/roles.decorator';
import type { PowerAction } from '../../connectors/adapter';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Get('resource-types')
  resourceTypes() {
    return this.service.resourceTypes();
  }

  @Get('vms')
  vms() {
    return this.service.listVms();
  }

  @Get('resources/:id')
  resourceDetail(@Param('id') id: string) {
    return this.service.resourceDetail(id);
  }

  @Post('resources/:id/action')
  control(@Param('id') id: string, @Body() body: { action: PowerAction }, @Req() req: any) {
    return this.service.controlVm(id, body?.action, req.user);
  }

  // Remove a resource from inventory + topology. Admin only.
  @Roles('admin')
  @Delete('resources/:id')
  deleteResource(@Param('id') id: string, @Req() req: any) {
    return this.service.deleteResource(id, req.user);
  }

  @Get('resources/:id/rdp')
  async rdp(@Param('id') id: string, @Res() res: Response) {
    const { filename, content } = await this.service.rdpFile(id);
    res.setHeader('Content-Type', 'application/x-rdp');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  @Get('resources')
  resources(
    @Query('provider') provider?: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    return this.service.resources({ provider, type, q, status });
  }
}
