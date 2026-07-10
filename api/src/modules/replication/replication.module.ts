import { Module } from '@nestjs/common';
import { ReplicationController } from './replication.controller';
import { ReplicationService } from './replication.service';
import { VpnController } from './vpn.controller';
import { VpnService } from './vpn.service';

@Module({
  controllers: [ReplicationController, VpnController],
  providers: [ReplicationService, VpnService],
})
export class ReplicationModule {}
