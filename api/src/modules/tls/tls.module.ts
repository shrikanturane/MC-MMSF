import { Module } from '@nestjs/common';
import { TlsController } from './tls.controller';
import { TlsService } from './tls.service';

@Module({
  controllers: [TlsController],
  providers: [TlsService],
  exports: [TlsService],
})
export class TlsModule {}
