import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Open integration API for 3rd-party ITSM (ServiceNow, Jira SM, …) and monitoring tools
 * (Datadog, Grafana, Zabbix, …). API-key authenticated, read-only, stable JSON.
 *
 * Auth: header `x-api-key: mcmf_…` (or `?api_key=`). Mint keys in Settings → Integrations → API keys.
 * @Public skips the JWT session guard; ApiKeyGuard then enforces the key.
 */
@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class PublicApiController {
  constructor(private readonly svc: ApiKeyService) {}

  /** Discovery: what this API exposes. */
  @Get()
  index() {
    return {
      api: 'mcmf-open-api', version: '1',
      endpoints: ['/api/v1/monitors', '/api/v1/devices', '/api/v1/agents', '/api/v1/alerts', '/api/v1/summary'],
      auth: 'x-api-key header',
      filters: { group: 'scope/group name', kind: 'host|device|agent' },
    };
  }

  /** All monitored entities (IP/Host monitors + network devices + guest agents), filterable. */
  @Get('monitors')
  monitors(@Query('group') group?: string, @Query('kind') kind?: any) {
    return this.svc.monitoringRows({ group, kind });
  }

  /** Network devices only (firewall/router/switch) with bandwidth + uptime. */
  @Get('devices')
  devices(@Query('group') group?: string) {
    return this.svc.monitoringRows({ group, kind: 'device' });
  }

  /** Guest agents only (CPU/memory/disk/heartbeat). */
  @Get('agents')
  agents(@Query('group') group?: string) {
    return this.svc.monitoringRows({ group, kind: 'agent' });
  }

  /** Active alerts — the feed an ITSM tool turns into incidents/tickets. */
  @Get('alerts')
  alerts() {
    return this.svc.alerts();
  }

  /** Per-scope SLA / up-down rollup. */
  @Get('summary')
  summary() {
    return this.svc.summary();
  }
}
