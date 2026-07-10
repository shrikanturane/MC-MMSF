import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { InventoryModule } from '../inventory/inventory.module';
import { ConnectionsModule } from '../connections/connections.module';
import { NetworkModule } from '../network/network.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [InventoryModule, ConnectionsModule, NetworkModule, DatabaseModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
})
export class ApprovalsModule {}
