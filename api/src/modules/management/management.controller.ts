import { Controller, Get, Post } from '@nestjs/common';
import { ManagementService } from './management.service';

@Controller('management')
export class ManagementController {
  constructor(private readonly service: ManagementService) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Get('summary')
  summary() {
    return this.service.summary();
  }

  @Post('refresh-cost')
  refreshCost() {
    return this.service.refreshCost();
  }

  @Get('accounts')
  accounts() {
    return this.service.accounts();
  }
}
