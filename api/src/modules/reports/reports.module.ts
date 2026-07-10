import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { OpenApiModule } from '../integration/integration.module';

@Module({
  imports: [OpenApiModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
