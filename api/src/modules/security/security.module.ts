import { Module } from '@nestjs/common';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { VaptScanner } from './vapt.scanner';

@Module({
  controllers: [SecurityController],
  providers: [SecurityService, VaptScanner],
})
export class SecurityModule {}
