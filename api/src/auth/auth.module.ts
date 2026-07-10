import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { RbacGuard } from './rbac.guard';
import { ModuleAccessGuard } from './module-access.guard';
import { AuditModule } from '../modules/audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Order matters: authenticate first, then authorize (RBAC role), then group-module access.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
    { provide: APP_GUARD, useClass: ModuleAccessGuard },
  ],
})
export class AuthModule {}
