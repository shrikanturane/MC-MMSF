import { Body, Controller, Post } from '@nestjs/common';
import { BackupService } from './backup.service';
import { Roles } from '../../auth/roles.decorator';

@Controller('backup')
export class BackupController {
  constructor(private readonly service: BackupService) {}

  // Create an encrypted backup of connections, vault & integrations — admin only.
  @Roles('admin')
  @Post()
  backup(@Body() body: { passphrase?: string }) {
    return this.service.backup(String(body?.passphrase ?? ''));
  }

  // Restore from an encrypted backup file — admin only.
  @Roles('admin')
  @Post('restore')
  restore(@Body() body: { file?: string; passphrase?: string }) {
    return this.service.restore(String(body?.file ?? ''), String(body?.passphrase ?? ''));
  }
}
