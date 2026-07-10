import { Body, Controller, Delete, Get, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get('sources')
  sources() {
    return this.service.sources();
  }

  @Get(':id/runs')
  runs(@Param('id') id: string) {
    return this.service.runs(id);
  }

  @Post(':id/run')
  run(@Param('id') id: string) {
    return this.service.run(id, 'manual');
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const { filename, content, contentType } = await this.service.download(id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  @Post()
  create(@Body() body: any) {
    return this.service.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
