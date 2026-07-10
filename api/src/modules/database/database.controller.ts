import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { DatabaseService } from './database.service';
import { Roles } from '../../auth/roles.decorator';

@Controller('database')
export class DatabaseController {
  constructor(private readonly service: DatabaseService) {}

  @Roles('admin')
  @Get('status')
  status() {
    return this.service.status();
  }

  // Fast log search over the ClickHouse log store.
  @Roles('admin')
  @Get('logs/search')
  searchLogs(@Query('q') q?: string, @Query('source') source?: string, @Query('limit') limit?: string) {
    return this.service.searchLogs({ q, source, limit: limit ? Number(limit) : undefined });
  }

  // Force a Postgres → ClickHouse log sync now.
  @Roles('admin')
  @Post('logs/sync')
  syncLogs() {
    return this.service.syncLogs();
  }

  @Roles('admin')
  @Get('backups')
  backups() {
    return this.service.backups();
  }

  // Download a backup to the operator's own machine (off-server). Admin only.
  @Roles('admin')
  @Get('backups/:name/download')
  downloadBackup(@Param('name') name: string, @Res() res: Response) {
    const p = this.service.backupFilePath(name);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
    createReadStream(p).pipe(res);
  }

  // Set the off-server backup destination (an NFS/network share mounted into the container).
  @Roles('admin')
  @Patch('backup-config')
  setBackupConfig(@Body() body: { externalPath?: string }) {
    return this.service.setBackupExternalPath(body?.externalPath ?? '');
  }

  @Roles('admin')
  @Post('backup')
  backupNow() {
    return this.service.backupNow();
  }

  // Full system snapshot: built docker images + source code + DB, bundled into one archive.
  @Roles('admin')
  @Post('full-snapshot')
  fullSnapshot() {
    return this.service.fullSnapshot();
  }

  // Generate a tailored failover/HA setup guide for a standby VM IP.
  @Roles('admin')
  @Post('failover-guide')
  failoverGuide(@Body() body: { standbyIp?: string; replPassword?: string }) {
    return this.service.failoverGuide(body ?? {});
  }

  // ── HA cluster (1 primary + up to 4 replicas) ──
  @Roles('admin')
  @Get('cluster')
  cluster() {
    return this.service.clusterStatus();
  }

  @Roles('admin')
  @Post('cluster/nodes')
  addNode(@Body() body: { name?: string; host?: string; role?: string; subnet?: string; sshUser?: string; sshPort?: number; sshPassword?: string }) {
    return this.service.addClusterNode(body ?? {});
  }

  // Save/replace a node's SSH credentials (used to enable one-click auto-deploy on an existing node).
  @Roles('admin')
  @Patch('cluster/nodes/:id/creds')
  setNodeCreds(@Param('id') id: string, @Body() body: { sshUser?: string; sshPort?: number; sshPassword?: string }) {
    return this.service.setClusterNodeCreds(id, body ?? {});
  }

  // One-click auto-deploy: full clone of the platform onto this replica over SSH.
  @Roles('admin')
  @Post('cluster/nodes/:id/deploy')
  deployNode(@Param('id') id: string, @Body() body: { sshUser?: string; sshPort?: number; sshPassword?: string }) {
    return this.service.deployReplica(id, body ?? {});
  }

  // Re-sync a deployed replica's data from the primary (data-only, no rebuild).
  @Roles('admin')
  @Post('cluster/nodes/:id/resync')
  resyncNode(@Param('id') id: string) {
    return this.service.resyncReplica(id);
  }

  // Execute a failover: promote this replica to primary over SSH and repoint agents/clients.
  @Roles('admin')
  @Post('cluster/nodes/:id/promote')
  promoteNode(@Param('id') id: string) {
    return this.service.promoteReplica(id);
  }

  // Tag a node's environment (development | test | production).
  @Roles('admin')
  @Patch('cluster/nodes/:id/environment')
  setNodeEnv(@Param('id') id: string, @Body() body: { environment?: string }) {
    return this.service.setNodeEnvironment(id, body?.environment ?? 'production');
  }

  // Stop / resume syncing to a node (operator "stop sync").
  @Roles('admin')
  @Patch('cluster/nodes/:id/sync-paused')
  setNodeSyncPaused(@Param('id') id: string, @Body() body: { paused?: boolean }) {
    return this.service.setNodeSyncPaused(id, !!body?.paused);
  }

  // This server's environment role (development | test | production).
  @Roles('admin')
  @Patch('cluster/env-label')
  setEnvLabel(@Body() body: { envLabel?: string }) {
    return this.service.setEnvLabel(body?.envLabel ?? 'production');
  }

  // Request an approval-gated Dev → Prod sync (full mirror). Does not sync until approved.
  @Roles('admin')
  @Post('cluster/nodes/:id/sync-to-prod')
  syncToProd(@Param('id') id: string, @Req() req: any) {
    return this.service.syncToProduction(id, req.user);
  }

  @Roles('admin')
  @Delete('cluster/nodes/:id')
  removeNode(@Param('id') id: string) {
    return this.service.removeClusterNode(id);
  }

  @Roles('admin')
  @Patch('cluster/cname')
  setCname(@Body() body: { cname?: string }) {
    return this.service.setClusterCname(body?.cname ?? '');
  }

  @Roles('admin')
  @Get('cluster/nodes/:id/setup')
  nodeSetup(@Param('id') id: string) {
    return this.service.clusterNodeGuide(id);
  }

  @Roles('admin')
  @Get('cluster/nodes/:id/promote')
  nodePromote(@Param('id') id: string) {
    return this.service.clusterPromoteGuide(id);
  }
}
