import { Injectable, Logger } from '@nestjs/common';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Reverse console relay for pure-outbound agents. The target host has NO inbound port, so guacd can't
 * reach it directly. Instead, per console session we open a TCP listener inside the api container that
 * guacd connects to, and bridge it to the agent's OUTBOUND WebSocket tunnel — the agent forwards the
 * bytes to its own localhost RDP/SSH. Path: guacd → api:relayPort → (ws) → agent → 127.0.0.1:targetPort.
 */
interface TunnelSession {
  id: string;
  agentId: string;
  targetPort: number;
  server: net.Server;
  relayPort: number;
  agentWs: any | null;          // ws.WebSocket from the agent
  relaySocket: net.Socket | null; // the guacd-side TCP connection
  fromAgent: Buffer[];          // agent→guacd bytes buffered until guacd connects
  bridged: boolean;
  timer: NodeJS.Timeout | null;
}

function agentKey(): string {
  return (process.env.AGENT_KEY || String(process.env.APP_ENCRYPTION_KEY).slice(0, 24)).trim();
}

@Injectable()
export class AgentTunnelHub {
  private readonly log = new Logger('AgentTunnel');
  private sessions = new Map<string, TunnelSession>();

  constructor(private readonly prisma: PrismaService) {}

  authKey(k?: string): boolean { return !!k && k === agentKey(); }
  has(id: string): boolean { return this.sessions.has(id); }

  /** Open a relay session: a server-side listener guacd dials, plus a queued console-open command
   *  telling the agent to connect its tunnel back. Returns the (host, port) to put in the guac token. */
  async openConsoleSession(agentId: string, targetPort: number): Promise<{ sessionId: string; relayHost: string; relayPort: number }> {
    const id = crypto.randomUUID();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => resolve());
    });
    const relayPort = (server.address() as net.AddressInfo).port;
    const session: TunnelSession = { id, agentId, targetPort, server, relayPort, agentWs: null, relaySocket: null, fromAgent: [], bridged: false, timer: null };
    this.sessions.set(id, session);

    server.on('connection', (sock) => {
      if (session.relaySocket) { sock.destroy(); return; } // one guacd connection per session
      session.relaySocket = sock;
      sock.pause();
      sock.on('error', () => this.close(id));
      sock.on('close', () => this.close(id));
      this.bridge(session);
    });

    // Drop the session if neither side wires up in time (agent offline, or console never opened).
    session.timer = setTimeout(() => this.close(id), 90_000);

    // Ask the agent to dial its tunnel back for this session.
    await this.prisma.agentCommand.create({ data: { agentId, kind: 'console-open', payload: { sessionId: id, targetPort } as any } }).catch(() => undefined);
    this.log.log(`console session ${id.slice(0, 8)} → agent ${agentId.slice(0, 8)} :${targetPort} (relay :${relayPort})`);
    return { sessionId: id, relayHost: process.env.GUACD_PEER_HOST || 'api', relayPort };
  }

  /** The agent's outbound WS arrived for this session — attach it and start bridging. */
  attachAgentWs(sessionId: string, ws: any) {
    const s = this.sessions.get(sessionId);
    if (!s) { try { ws.close(); } catch { /* */ } return; }
    s.agentWs = ws;
    ws.on('message', (data: Buffer) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      if (s.relaySocket && s.bridged) s.relaySocket.write(buf);
      else s.fromAgent.push(buf);
    });
    ws.on('close', () => this.close(sessionId));
    ws.on('error', () => this.close(sessionId));
    this.bridge(s);
  }

  private bridge(s: TunnelSession) {
    if (s.bridged || !s.agentWs || !s.relaySocket) return;
    s.bridged = true;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    // Flush any agent→guacd bytes that arrived before guacd connected.
    for (const b of s.fromAgent) s.relaySocket.write(b);
    s.fromAgent = [];
    // guacd→agent.
    s.relaySocket.on('data', (d) => { try { s.agentWs.send(d); } catch { /* */ } });
    s.relaySocket.resume();
    this.log.log(`console session ${s.id.slice(0, 8)} bridged`);
  }

  private close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (s.timer) { try { clearTimeout(s.timer); } catch { /* */ } }
    try { s.relaySocket?.destroy(); } catch { /* */ }
    try { s.agentWs?.close(); } catch { /* */ }
    try { s.server.close(); } catch { /* */ }
  }
}
