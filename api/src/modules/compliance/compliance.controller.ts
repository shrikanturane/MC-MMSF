import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('governance')
@Controller('compliance')
export class ComplianceController {
  constructor(private readonly service: ComplianceService) {}

  @Get('items')
  list(@Query('standard') standard?: string) {
    return this.service.list(standard);
  }

  @Get('standards')
  standards() {
    return this.service.standards();
  }

  @Post('items')
  create(@Body() b: any) {
    return this.service.create(b ?? {});
  }

  @Patch('items/:id')
  update(@Param('id') id: string, @Body() b: any) {
    return this.service.update(id, b ?? {});
  }

  @Delete('items/:id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
