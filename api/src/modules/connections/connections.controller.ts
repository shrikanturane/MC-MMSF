import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ConnectionsService } from './connections.service';

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly service: ConnectionsService) {}

  @Get('providers')
  providers() {
    return this.service.providers();
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(@Body() body: any) {
    return this.service.create(body ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body ?? {});
  }

  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.service.test(id);
  }

  @Post(':id/sync')
  sync(@Param('id') id: string) {
    return this.service.sync(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
