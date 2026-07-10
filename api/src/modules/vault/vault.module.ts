import { Module } from '@nestjs/common';
import { VaultController } from './vault.controller';
import { VaultService } from './vault.service';
import { AuditModule } from '../audit/audit.module';

@Module({ imports: [AuditModule], controllers: [VaultController], providers: [VaultService] })
export class VaultModule {}
