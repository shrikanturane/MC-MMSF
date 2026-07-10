import { Controller, Get } from '@nestjs/common';
import { CommandCenterService } from './command-center.service';
import { RequireModule } from '../../auth/require-module.decorator';

@RequireModule('commandCenter')
@Controller('command-center')
export class CommandCenterController {
  constructor(private readonly service: CommandCenterService) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }
}
