import { Module } from '@nestjs/common';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { TlsModule } from '../tls/tls.module';

@Module({
  imports: [TlsModule], // DomainsService delegates HTTPS issuance to TlsService's ACME engine
  controllers: [DomainsController],
  providers: [DomainsService],
})
export class DomainsModule {}
