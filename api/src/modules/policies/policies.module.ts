import { Module } from '@nestjs/common';
import { PoliciesController } from './policies.controller';
import { PoliciesService } from './policies.service';

@Module({
  controllers: [PoliciesController],
  providers: [PoliciesService],
  exports: [PoliciesService], // optimization (Layer 12) reads violations + applies approved policy tightening
})
export class PoliciesModule {}
