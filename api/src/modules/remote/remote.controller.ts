import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { RemoteService } from './remote.service';
import { Roles } from '../../auth/roles.decorator';
import { Public } from '../../auth/public.decorator';
import { RequireModule } from '../../auth/require-module.decorator';

/**
 * Attended remote support (Windows main-console). The UI lives in the Connect / Remote Console tabs, so
 * access is gated by the 'commandCenter' module permission — same convention as AiopsController gating
 * on 'ai' because its tabs live under the AI Engine page.
 *
 * The two agent-facing routes are @Public because the agent presents its own token, not a user session
 * (same pattern as the agent ingest/command endpoints).
 */
@RequireModule('commandCenter')
@Controller('remote')
export class RemoteController {
  constructor(private readonly service: RemoteService) {}

  @Get('sessions')
  list(@Query('agentId') agentId?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.service.list({ agentId, status, limit: limit ? Number(limit) : undefined });
  }

  @Get('sessions/:id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /** Operator asks to remote a host. Nothing is captured until consent resolves. */
  @Roles('admin', 'operator')
  @Post('sessions')
  request(@Body() body: any, @Req() req: any) {
    return this.service.request(body ?? {}, req.user ?? {});
  }

  /**
   * Hand the target's keyboard and mouse to the operator, or take it back. Separate from consent and
   * separately audited: agreeing to be watched is not agreeing to be typed on.
   */
  @Roles('admin', 'operator')
  @Post('sessions/:id/input/enable')
  setInput(@Param('id') id: string, @Body() body: { enabled?: boolean }, @Req() req: any) {
    return this.service.setInput(id, body?.enabled !== false, req.user ?? {});
  }

  /**
   * Start or stop recording mid-session. Audited both ways — "we stopped recording at 14:12" is exactly
   * the fact an auditor needs and exactly the one a silent toggle would lose.
   */
  @Roles('admin', 'operator')
  @Post('sessions/:id/recording')
  setRecording(@Param('id') id: string, @Body() body: { on?: boolean }, @Req() req: any) {
    return this.service.setRecording(id, body?.on !== false, req.user ?? {});
  }

  /**
   * Share two-way audio with the target, or stop. Separate from input and consent and separately audited:
   * agreeing to be watched or typed on is not agreeing to share a microphone and speakers.
   */
  @Roles('admin', 'operator')
  @Post('sessions/:id/audio')
  setAudio(@Param('id') id: string, @Body() body: { enabled?: boolean }, @Req() req: any) {
    return this.service.setAudio(id, body?.enabled !== false, req.user ?? {});
  }

  /** Change the console quality mode (min | medium | good | high) mid-session. Trades sharpness for bandwidth. */
  @Roles('admin', 'operator')
  @Post('sessions/:id/quality')
  setQuality(@Param('id') id: string, @Body() body: { mode?: string }) {
    return this.service.setQuality(id, body?.mode);
  }

  /** A batch of operator keyboard/mouse. Refused unless the session is active and control is enabled. */
  @Roles('admin', 'operator')
  @Post('sessions/:id/input')
  input(@Param('id') id: string, @Body() body: any) {
    return this.service.queueInput(id, body ?? {});
  }

  @Roles('admin', 'operator')
  @Post('sessions/:id/end')
  end(@Param('id') id: string) {
    return this.service.end(id);
  }

  // ── agent-facing (agent token, not a user session) ────────────────────────

  /** Tray poll: is anyone asking to remote this box? Agent-token authed. */
  @Public()
  @Post('agent/poll')
  agentPoll(@Body() body: any) {
    return this.service.agentPoll(body ?? {});
  }

  /** Agent reached the console and reports who (if anyone) is sitting at it. */
  @Public()
  @Post('sessions/:id/ack')
  ack(@Param('id') id: string, @Body() body: any) {
    return this.service.agentAck(id, body ?? {});
  }

  /** The person at the console clicked Accept or Decline. */
  @Public()
  @Post('sessions/:id/consent')
  consent(@Param('id') id: string, @Body() body: any) {
    return this.service.consentAnswer(id, body ?? {});
  }

  /**
   * A captured frame. Returns { stop: true } the moment the session is no longer active, which is how
   * a declined/ended session stops the capture loop on the target.
   */
  @Public()
  @Post('sessions/:id/frame')
  frame(@Param('id') id: string, @Body() body: any) {
    return this.service.ingestFrame(id, body ?? {});
  }

  /**
   * One part of a session recording (H.264). Admin-only: it is a video of somebody's desktop.
   * Sessions are segmented into fixed-size parts; ?part=N selects which (defaults to the first).
   */
  @Roles('admin')
  @Get('sessions/:id/recording.mp4')
  recording(@Param('id') id: string, @Req() req: any, @Res() res: any, @Query('part') part?: string, @Query('download') download?: string) {
    return this.service.streamRecording(id, req, res, part ? Number(part) : 1, download === '1' || download === 'true');
  }

  /**
   * The recording library: past sessions that still have video on disk, newest first. Admin-only for
   * the same reason the files are — these are videos of people's desktops.
   */
  @Roles('admin')
  @Get('recordings')
  recordings(@Query('limit') limit?: string) {
    return this.service.recordings(limit ? Number(limit) : 100);
  }

  /** How much disk the recordings are using, and the retention policy in force. */
  @Roles('admin')
  @Get('storage')
  storage() {
    return this.service.storageUsage();
  }

  /**
   * Clear recording storage. ?olderThanDays=N clears only what is older than N days; omit it to clear
   * everything. Admin-only and audited — this deletes recordings of people's desktops.
   */
  @Roles('admin')
  @Post('storage/clear')
  clearStorage(@Body() body: { olderThanDays?: number }) {
    const d = Number(body?.olderThanDays);
    return this.service.clearStorage(Number.isFinite(d) && d > 0 ? d : undefined);
  }

  /** Clear a single session's recording from disk (admin-only, audited). */
  @Roles('admin')
  @Delete('sessions/:id/recording')
  clearSessionRecording(@Param('id') id: string) {
    return this.service.clearSessionRecording(id);
  }

  /** Latest frame, as an image, for the operator's viewer (Phase 4 renders this). */
  @Get('sessions/:id/frame.jpg')
  frameJpg(@Param('id') id: string, @Res() res: any) {
    const f = this.service.latestFrame(id);
    if (!f) { res.status(404).json({ message: 'no frame yet' }); return; }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(f.buf);
  }
}
