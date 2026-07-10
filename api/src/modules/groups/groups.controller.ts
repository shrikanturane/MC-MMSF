import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { GroupsService } from './groups.service';
import { Roles } from '../../auth/roles.decorator';

@Controller('groups')
export class GroupsController {
  constructor(private readonly service: GroupsService) {}

  // Readable by any authenticated user (e.g. to target a group when creating a channel).
  @Get()
  list() {
    return this.service.list();
  }

  @Roles('admin')
  @Post()
  create(@Body() body: any) {
    return this.service.create(body);
  }

  @Roles('admin')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Roles('admin')
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() body: { userId?: string }) {
    return this.service.addMember(id, body?.userId ?? '');
  }

  @Roles('admin')
  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.service.removeMember(id, userId);
  }
}
