import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { ConnectionsModule } from '../connections/connections.module';

@Module({
  imports: [ConnectionsModule], // ConnectionsService → inventory re-sync after a cloud apply
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
