import { Module } from '@nestjs/common';
import { FabricController } from './fabric.controller';
import { FabricService } from './fabric.service';

@Module({
  controllers: [FabricController],
  providers: [FabricService],
})
export class FabricModule {}
