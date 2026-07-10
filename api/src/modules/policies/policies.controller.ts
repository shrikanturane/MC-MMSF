import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PoliciesService } from './policies.service';
import { Roles } from '../../auth/roles.decorator';

@Controller('policies')
export class PoliciesController {
  constructor(private readonly service: PoliciesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get('environments')
  environments() {
    return this.service.environments();
  }

  @Get('violations')
  violations(@Query('policyId') policyId?: string) {
    return this.service.violations(policyId);
  }

  // Triggering an evaluation is an operator+ action (default matrix blocks viewers).
  @Post('evaluate')
  evaluate() {
    return this.service.evaluate();
  }

  // Authoring governance policies is an admin action.
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
}
