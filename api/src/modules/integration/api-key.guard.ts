import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';

/** Guards the open /api/v1 integration API: requires a valid x-api-key (or ?api_key=). */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeyService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const raw: string = req.headers['x-api-key'] || req.query?.api_key || '';
    const key = await this.keys.validate(String(raw));
    if (!key) throw new UnauthorizedException('a valid x-api-key is required');
    req.apiKey = key;
    return true;
  }
}
