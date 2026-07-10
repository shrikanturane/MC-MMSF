import { Module } from '@nestjs/common';
import { ZeroTrustController } from './zerotrust.controller';
import { ZeroTrustService } from './zerotrust.service';
import { NetworkModule } from '../network/network.module';

@Module({ imports: [NetworkModule], controllers: [ZeroTrustController], providers: [ZeroTrustService] })
export class ZeroTrustModule {}
