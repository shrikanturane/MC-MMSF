import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { FabricService } from './fabric.service';

@Controller('fabric')
export class FabricController {
  constructor(private readonly service: FabricService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Roles('admin', 'operator')
  @Post()
  create(@Body() body: any) {
    return this.service.create(body ?? {});
  }

  @Roles('admin', 'operator')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body ?? {});
  }

  @Roles('admin', 'operator')
  @Post(':id/arm')
  arm(@Param('id') id: string) {
    return this.service.arm(id);
  }

  @Roles('admin', 'operator')
  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.service.retry(id);
  }

  @Roles('admin', 'operator')
  @Post(':id/deprovision')
  deprovision(@Param('id') id: string) {
    return this.service.deprovision(id);
  }

  @Roles('admin', 'operator')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
