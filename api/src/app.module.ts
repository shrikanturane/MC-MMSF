import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AccessControlMiddleware } from './modules/access/access-control.middleware';
import { HealthController } from './health.controller';
import { ManagementModule } from './modules/management/management.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { SecurityModule } from './modules/security/security.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CommandCenterModule } from './modules/command-center/command-center.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ConnectionsModule } from './modules/connections/connections.module';
import { AlertingModule } from './modules/alerting/alerting.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MonitorsModule } from './modules/monitors/monitors.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { UsersModule } from './modules/users/users.module';
import { AuditModule } from './modules/audit/audit.module';
import { PoliciesModule } from './modules/policies/policies.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ReplicationModule } from './modules/replication/replication.module';
import { FabricModule } from './modules/fabric/fabric.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { NetworkModule } from './modules/network/network.module';
import { ActivityModule } from './modules/activity/activity.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { GroupsModule } from './modules/groups/groups.module';
import { ConsoleModule } from './modules/console/console.module';
import { AgentModule } from './modules/agent/agent.module';
import { AiModule } from './modules/ai/ai.module';
import { AiopsModule } from './modules/aiops/aiops.module';
import { OptimizationModule } from './modules/optimization/optimization.module';
import { CiemModule } from './modules/ciem/ciem.module';
import { ZeroTrustModule } from './modules/zerotrust/zerotrust.module';
import { VaultModule } from './modules/vault/vault.module';
import { BackupModule } from './modules/backup/backup.module';
import { DatabaseModule } from './modules/database/database.module';
import { FinOpsModule } from './modules/finops/finops.module';
import { OpenApiModule } from './modules/integration/integration.module';
import { TlsModule } from './modules/tls/tls.module';
import { DomainsModule } from './modules/domains/domains.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    // API rate limiting (per real client IP via trust-proxy). Generous default for the polling UI;
    // brute-force-sensitive routes (auth) tighten this with @Throttle. Agents are per-IP, low rate.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    PrismaModule,
    AuthModule,
    ManagementModule,
    MonitoringModule,
    SecurityModule,
    InventoryModule,
    CommandCenterModule,
    SettingsModule,
    ConnectionsModule,
    AlertingModule,
    DashboardModule,
    MonitorsModule,
    ComplianceModule,
    UsersModule,
    AuditModule,
    PoliciesModule,
    ReportsModule,
    ReplicationModule,
    FabricModule,
    ApprovalsModule,
    NetworkModule,
    ActivityModule,
    IntegrationsModule,
    OpenApiModule,
    TlsModule,
    DomainsModule,
    CatalogModule,
    GroupsModule,
    ConsoleModule,
    AgentModule,
    AiModule,
    AiopsModule,
    OptimizationModule,
    CiemModule,
    ZeroTrustModule,
    VaultModule,
    BackupModule,
    DatabaseModule,
    FinOpsModule,
  ],
  controllers: [HealthController],
  providers: [AccessControlMiddleware, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Network access control runs on every request (cheap, cached) and 403s blocked IPs/subnets.
    consumer.apply(AccessControlMiddleware).forRoutes('*');
  }
}
