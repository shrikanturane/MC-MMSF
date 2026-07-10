import { Module } from '@nestjs/common';
import { ConsoleController } from './console.controller';
import { ConsoleService } from './console.service';
import { AgentModule } from '../agent/agent.module';

@Module({ imports: [AgentModule], controllers: [ConsoleController], providers: [ConsoleService] })
export class ConsoleModule {}
