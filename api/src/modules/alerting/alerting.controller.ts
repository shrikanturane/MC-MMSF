import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AlertingService } from './alerting.service';
import { AlertingEngine } from './alerting.engine';

@Controller('alerting')
export class AlertingController {
  constructor(
    private readonly service: AlertingService,
    private readonly engine: AlertingEngine,
  ) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  // Rules
  @Get('rules') listRules() {
    return this.service.listRules();
  }
  @Post('rules') createRule(@Body() b: any) {
    return this.service.createRule(b ?? {});
  }
  @Post('rules/test') testRuleNotify(@Body() b: any) {
    return this.service.testRuleNotify(b ?? {});
  }
  @Patch('rules/:id') updateRule(@Param('id') id: string, @Body() b: any) {
    return this.service.updateRule(id, b ?? {});
  }
  @Delete('rules/:id') removeRule(@Param('id') id: string) {
    return this.service.removeRule(id);
  }

  // Workflows
  @Get('workflows') listWorkflows() {
    return this.service.listWorkflows();
  }
  @Post('workflows') createWorkflow(@Body() b: any) {
    return this.service.createWorkflow(b ?? {});
  }
  @Patch('workflows/:id') updateWorkflow(@Param('id') id: string, @Body() b: any) {
    return this.service.updateWorkflow(id, b ?? {});
  }
  @Delete('workflows/:id') removeWorkflow(@Param('id') id: string) {
    return this.service.removeWorkflow(id);
  }

  // Notification channels
  @Get('channels') listChannels() {
    return this.service.listChannels();
  }
  @Post('channels') createChannel(@Body() b: any) {
    return this.service.createChannel(b ?? {});
  }
  @Patch('channels/:id') updateChannel(@Param('id') id: string, @Body() b: any) {
    return this.service.updateChannel(id, b ?? {});
  }
  @Delete('channels/:id') removeChannel(@Param('id') id: string) {
    return this.service.removeChannel(id);
  }
  // Fire a test notification through a channel → returns {ok, error}.
  @Post('channels/:id/test') testChannel(@Param('id') id: string) {
    return this.engine.testChannel(id);
  }

  // Delivery monitoring log (sent / failed + exact error).
  @Get('deliveries') deliveries(@Query('limit') limit?: string) {
    return this.service.deliveries(limit ? Number(limit) : undefined);
  }
  // Manually re-send a failed (or any) logged delivery now.
  @Post('deliveries/:id/retry') retryDelivery(@Param('id') id: string) {
    return this.engine.retryLog(id);
  }
  // Remove a delivery-log entry.
  @Delete('deliveries/:id') removeDelivery(@Param('id') id: string) {
    return this.service.deleteDelivery(id);
  }

  // Escalations
  @Get('escalations') listEscalations() {
    return this.service.listEscalations();
  }
  @Post('escalations') createEscalation(@Body() b: any) {
    return this.service.createEscalation(b ?? {});
  }
  @Patch('escalations/:id') updateEscalation(@Param('id') id: string, @Body() b: any) {
    return this.service.updateEscalation(id, b ?? {});
  }
  @Delete('escalations/:id') removeEscalation(@Param('id') id: string) {
    return this.service.removeEscalation(id);
  }

  // Alerts
  @Get('alerts') listAlerts(@Query('status') status?: string) {
    return this.service.listAlerts(status);
  }
  @Post('alerts/:id/acknowledge') ack(@Param('id') id: string) {
    return this.service.acknowledgeAlert(id);
  }
  @Post('alerts/:id/resolve') resolve(@Param('id') id: string) {
    return this.service.resolveAlert(id);
  }

  @Post('evaluate') evaluate() {
    return this.service.evaluateNow();
  }
}
