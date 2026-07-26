import { Module } from '@nestjs/common';
import { RemoteController } from './remote.controller';
import { RemoteService } from './remote.service';
import { RemoteMediaHub } from './media.hub';

@Module({
  controllers: [RemoteController],
  providers: [RemoteService, RemoteMediaHub],
  exports: [RemoteService, RemoteMediaHub], // main.ts attaches the media WS relay to the raw http server
})
export class RemoteModule {}
