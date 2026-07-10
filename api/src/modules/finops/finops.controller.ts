import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { FinOpsService } from './finops.service';
import { Roles } from '../../auth/roles.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('finops')
@Controller('finops')
export class FinOpsController {
  constructor(private readonly service: FinOpsService) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Get('carbon')
  carbon() {
    return this.service.carbon();
  }

  @Get('budgets')
  budgets() {
    return this.service.listBudgets();
  }

  @Roles('admin')
  @Post('budgets')
  createBudget(@Body() body: any) {
    return this.service.createBudget(body);
  }

  @Roles('admin')
  @Patch('budgets/:id')
  updateBudget(@Param('id') id: string, @Body() body: any) {
    return this.service.updateBudget(id, body);
  }

  @Roles('admin')
  @Delete('budgets/:id')
  deleteBudget(@Param('id') id: string) {
    return this.service.deleteBudget(id);
  }
}
