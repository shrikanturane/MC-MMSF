import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentTunnelHub } from './agent-tunnel.hub';

@Module({ controllers: [AgentController], providers: [AgentService, AgentTunnelHub], exports: [AgentTunnelHub] })
export class AgentModule {}
