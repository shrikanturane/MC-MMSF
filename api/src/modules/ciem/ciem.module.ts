import { Module } from '@nestjs/common';
import { CiemController } from './ciem.controller';
import { CiemService } from './ciem.service';

@Module({ controllers: [CiemController], providers: [CiemService], exports: [CiemService] })
export class CiemModule {}
