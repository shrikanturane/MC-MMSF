import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeysController } from './api-keys.controller';
import { PublicApiController } from './public-api.controller';

/** Open integration API (/api/v1) for 3rd-party ITSM & monitoring tools + its API-key management. */
@Module({
  controllers: [ApiKeysController, PublicApiController],
  providers: [ApiKeyService, ApiKeyGuard],
  exports: [ApiKeyService],
})
export class OpenApiModule {}
