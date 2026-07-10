import { BadRequestException, Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptJson, decryptJson } from '../../connectors/crypto';
import { cleanCreds } from '../../connectors/adapter';
import { AgentTunnelHub } from '../agent/agent-tunnel.hub';
import { brokerAwsSsh, brokerGcpSsh, brokerAzureSsh, type BrokeredSsh } from './cloud-ssh';

const PROTO_PORT: Record<string, number> = { rdp: 3389, ssh: 22, telnet: 23, vnc: 5900 };

/** 32-byte AES key shared with guacamole-lite (derived from the app key). */
function guacKey(): Buffer {
  const k = String(process.env.APP_ENCRYPTION_KEY).slice(0, 32).padEnd(32, '0');
  return Buffer.from(k, 'utf8');
}

@Injectable()
export class ConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tunnel: AgentTunnelHub,
  ) {}

  /**
   * A pure-outbound agent for this host (no inbound port) → console goes through its tunnel.
   * Only returns an agent that is ACTIVELY polling (lastPollAt within ~3 min). A stale/offline
   * agent can't dial its tunnel back, so routing the console through it would hang at "Connecting";
   * returning null lets the caller fall back to a direct connection (which works if the host's port
   * is reachable, e.g. a cloud VM with a public IP). The agent's command long-poll cycles ~35s.
   */
  private async outboundAgentFor(host: string) {
    const agents = await this.prisma.agent.findMany({ where: { outbound: true, active: true } });
    const match = agents.find((a) => a.hostname === host || String(a.ips ?? '').split(',').map((s) => s.trim()).includes(host));
    if (!match) return null;
    const lastPoll = (match as any).lastPollAt as Date | null;
    const online = !!lastPoll && Date.now() - new Date(lastPoll).getTime() < 3 * 60_000;
    return online ? match : null;
  }

  /** IPs we permit connecting to = discovered VM public/private IPs (SSRF guard). */
  private async allowedHosts(): Promise<Set<string>> {
    const resources = await this.prisma.resource.findMany();
    const ips = new Set<string>();
    for (const r of resources) {
      const p = (r.properties as any) ?? {};
      if (p.publicIp) ips.add(String(p.publicIp).trim());
      if (p.privateIp) ips.add(String(p.privateIp).trim());
    }
    return ips;
  }

  /** Saved-credential status for a host+protocol (never returns the password). */
  async getCred(userId: string, host: string, protocol: string) {
    const h = String(host ?? '').trim();
    const p = String(protocol ?? '').toLowerCase();
    if (!h || !p) return { saved: false };
    const row = await this.prisma.vmCredential.findUnique({ where: { userId_host_protocol: { userId, host: h, protocol: p } } });
    return row ? { saved: true, username: row.username, hasKey: !!(row as any).privateKey } : { saved: false };
  }

  /** Store/replace the user's per-VM credentials (password OR private key, sealed at rest). */
  async setCred(userId: string, body: { host?: string; protocol?: string; username?: string; password?: string; privateKey?: string; passphrase?: string }) {
    const host = String(body?.host ?? '').trim();
    const protocol = String(body?.protocol ?? '').toLowerCase();
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    const privateKey = String(body?.privateKey ?? '').trim();
    if (!host || !protocol || !username || (!password && !privateKey)) throw new BadRequestException('host, protocol, username and a password OR a private key are required');
    const allowed = await this.allowedHosts();
    if (!allowed.has(host)) throw new BadRequestException('host is not a known VM address');
    const data: any = {
      username,
      password: password ? encryptJson(password) : '',
      privateKey: privateKey ? encryptJson(privateKey) : '',
      keyPassphrase: body?.passphrase ? encryptJson(String(body.passphrase)) : '',
    };
    await this.prisma.vmCredential.upsert({
      where: { userId_host_protocol: { userId, host, protocol } },
      update: data,
      create: { userId, host, protocol, ...data },
    });
    return { ok: true };
  }

  async deleteCred(userId: string, host: string, protocol: string) {
    await this.prisma.vmCredential.deleteMany({ where: { userId, host: String(host ?? '').trim(), protocol: String(protocol ?? '').toLowerCase() } });
    return { ok: true };
  }

  /** Mint an encrypted Guacamole connection token (validates host, never echoes secrets). */
  /**
   * Broker a single-use SSH key for a discovered cloud VM using the account's stored cloud
   * credentials, so the operator doesn't manage SSH keys. Matches the VM by IP → provider →
   * connection. AWS via EC2 Instance Connect; GCP/Azure land in later phases.
   */
  async brokerCloudSsh(host: string, osUser: string): Promise<BrokeredSsh> {
    const resources = await this.prisma.resource.findMany({
      where: { provider: { in: ['aws', 'gcp', 'azure'] as any }, type: 'compute' as any },
      include: { cloudAccount: { select: { connectionId: true } } },
    });
    const r = resources.find((x) => { const p = (x.properties as any) ?? {}; return p.publicIp === host || p.privateIp === host; });
    if (!r) throw new BadRequestException('This IP is not a discovered cloud VM, so cloud-credential SSH is unavailable — paste a private key instead.');
    if (!r.cloudAccount?.connectionId) throw new BadRequestException('This VM has no linked cloud connection.');
    const conn = await this.prisma.cloudConnection.findUnique({ where: { id: r.cloudAccount.connectionId } });
    if (!conn) throw new BadRequestException('The cloud connection for this VM was not found.');
    const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    const props = (r.properties as any) ?? {};
    try {
      if (r.provider === 'aws') return await brokerAwsSsh(creds as any, r.region, r.externalId, osUser);
      if (r.provider === 'gcp') return await brokerGcpSsh(creds as any, props.zone, r.name, osUser);
      if (r.provider === 'azure') return await brokerAzureSsh(creds as any, r.externalId, r.region, osUser);
    } catch (e) {
      throw new BadRequestException(String((e as Error)?.message ?? e).slice(0, 300));
    }
    throw new BadRequestException(`Connect-with-cloud-credentials isn't enabled yet for ${r.provider} (coming soon) — paste a private key for now.`);
  }

  async token(userId: string, body: { host?: string; protocol?: string; port?: number; username?: string; password?: string; privateKey?: string; passphrase?: string; useCloudCreds?: boolean; save?: boolean; security?: string; domain?: string; rawShell?: boolean }) {
    const host = String(body?.host ?? '').trim();
    const protocol = String(body?.protocol ?? '').toLowerCase();
    if (!['rdp', 'ssh', 'telnet', 'vnc'].includes(protocol)) throw new BadRequestException('unsupported protocol');
    if (!host) throw new BadRequestException('host required');
    // A pure-outbound agent host is a known managed endpoint even if it isn't a discovered cloud IP.
    const outboundAgent = await this.outboundAgentFor(host);
    const allowed = await this.allowedHosts();
    if (!allowed.has(host) && !outboundAgent) throw new BadRequestException('host is not a known VM address — only discovered VM IPs may be reached');
    const port = Number(body?.port || PROTO_PORT[protocol]);

    let username = body?.username?.trim() || '';
    let password = body?.password || '';
    let privateKey = String(body?.privateKey ?? '').trim();
    let passphrase = String(body?.passphrase ?? '');

    // "Use cloud credentials": broker an ephemeral SSH key with the account's stored cloud creds
    // (AWS EC2 Instance Connect, …) so the operator never pastes a key. Ephemeral — never saved.
    if (body?.useCloudCreds && protocol === 'ssh') {
      const b = await this.brokerCloudSsh(host, username);
      username = b.username; privateKey = b.privateKey; password = ''; passphrase = '';
    }

    // Save to the user's vault if asked (and we have a username + a secret). Never persist a
    // brokered ephemeral key — it's single-use.
    if (body?.save && !body?.useCloudCreds && username && (password || privateKey)) {
      await this.setCred(userId, { host, protocol, username, password, privateKey, passphrase }).catch(() => undefined);
    }
    // Fall back to the user's saved credentials (auto-pickup by IP + service) when nothing was passed.
    if (!password && !privateKey) {
      const row = await this.prisma.vmCredential.findUnique({ where: { userId_host_protocol: { userId, host, protocol } } });
      if (row) {
        username = username || row.username;
        try { if (row.password) password = decryptJson<string>(row.password); } catch { /* corrupt seal */ }
        try { if ((row as any).privateKey) privateKey = decryptJson<string>((row as any).privateKey); } catch { /* corrupt seal */ }
        try { if ((row as any).keyPassphrase) passphrase = decryptJson<string>((row as any).keyPassphrase); } catch { /* corrupt seal */ }
      }
    }
    // Resolve a SHARED credential (password OR vaulted private key) when the user has none of their own.
    if (!password && !privateKey) {
      // Provisioned/admin creds are keyed by VM NAME (the public IP is async), so map host-IP → its
      // compute Resource → name. sharedWith governs access: "all" = every user, JSON id array = selected.
      const computes = await this.prisma.resource.findMany({ where: { type: 'compute' as any }, select: { name: true, properties: true } as any }).catch(() => [] as any[]);
      const res = (computes as any[]).find((x) => { const pr = (x.properties as any) ?? {}; return pr.publicIp === host || pr.privateIp === host; });
      const names = [host, res?.name].filter(Boolean) as string[];
      const cands = await this.prisma.vmCredential.findMany({ where: { host: { in: names }, protocol } }).catch(() => [] as any[]);
      const canUse = (sw: string) => { if (sw === 'all') return true; if (sw.startsWith('[')) { try { return JSON.parse(sw).includes(userId); } catch { return false; } } return false; };
      const shared = (cands as any[]).find((c) => canUse(String((c as any).sharedWith ?? '')));
      if (shared) {
        username = username || shared.username;
        try { if (shared.password) password = decryptJson<string>(shared.password); } catch { /* corrupt seal */ }
        try { if (shared.privateKey) privateKey = decryptJson<string>(shared.privateKey); } catch { /* corrupt seal */ }
        try { if (shared.keyPassphrase) passphrase = decryptJson<string>(shared.keyPassphrase); } catch { /* corrupt seal */ }
      }
    }

    const settings: Record<string, any> = { hostname: host, port: String(port), width: 1366, height: 768, dpi: 96 };
    // Pure-outbound agent: guacd can't reach the host directly. Open a relay session and point guacd
    // at the server-side relay listener, which bridges through the agent's outbound tunnel to its
    // own localhost:port. The agent connects its WS back within a couple of seconds (command poll).
    if (outboundAgent) {
      const relay = await this.tunnel.openConsoleSession(outboundAgent.id, port);
      settings.hostname = relay.relayHost;
      settings.port = String(relay.relayPort);
    }
    if (username) settings.username = username;
    // SSH key-auth (GCP/AWS and any key-only host) — guacd uses 'private-key' (+ optional passphrase).
    // Key takes precedence over password when both are present.
    if (protocol === 'ssh' && privateKey) {
      settings['private-key'] = privateKey;
      if (passphrase) settings.passphrase = passphrase;
    } else if (password) {
      settings.password = password;
    }
    if (protocol === 'ssh') {
      // Launch a clean interactive shell that skips the host's rc files (~/.bashrc). Some hosts run
      // shell integrations — Amazon Q / Fig (OSC 697), Powerlevel10k, etc. — that emit escape
      // sequences guacd's terminal can't render, so they leak as garbage text. --norc avoids loading
      // them. We still set a useful prompt (user@host:cwd) + a 256-colour TERM, and fall back to sh
      // on hosts without bash. (Native SSH / a downloaded key still gives the full customised shell.)
      if (!body?.rawShell) settings.command = "PS1='\\u@\\h:\\w\\$ ' TERM=xterm-256color bash --norc -i || sh -i";
    }
    if (protocol === 'rdp') {
      // Black-screen fixes: explicit security mode (NLA-capable), trust self-signed certs,
      // 32-bit colour, correct resize parameter name, and ignore the secure-desktop blank.
      const sec = ['any', 'nla', 'nla-ext', 'tls', 'rdp', 'vmconnect'].includes(String(body?.security)) ? String(body!.security) : 'any';
      settings.security = sec;
      settings['ignore-cert'] = 'true';
      settings['resize-method'] = 'display-update';
      settings['color-depth'] = '32';
      settings['enable-wallpaper'] = 'true';
      if (body?.domain) settings.domain = body.domain;
      // Bidirectional text clipboard (copy/paste between local PC and the VM).
      settings['disable-copy'] = 'false';
      settings['disable-paste'] = 'false';
      // File sharing via RDP drive redirection — the VM gets an "MCMF Share" drive;
      // the browser can upload files into it (→ VM) and download files from it (← VM).
      settings['enable-drive'] = 'true';
      settings['drive-name'] = 'MCMF Share';
      settings['drive-path'] = `/tmp/mcmf-guacdrive/${host.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      settings['create-drive-path'] = 'true';
    }

    return { token: this.encrypt({ connection: { type: protocol, settings } }) };
  }

  /** TCP reachability probe from the MCMF server to the VM's console port (pre-connect). */
  async check(body: { host?: string; protocol?: string; port?: number }) {
    const host = String(body?.host ?? '').trim();
    const protocol = String(body?.protocol ?? 'rdp').toLowerCase();
    const port = Number(body?.port || PROTO_PORT[protocol] || 0);
    if (!host) throw new BadRequestException('host required');
    // A host with a pure-outbound agent is reached through the agent's outbound tunnel, not by a
    // direct network path — so a direct probe would wrongly fail (e.g. a private LAN host behind NAT
    // from a cloud-hosted MCMF). Report it reachable and let the tunnel handle the connection.
    const agent = await this.outboundAgentFor(host);
    if (agent) return { reachable: true, host, port, detail: `Reachable through the ${agent.name} agent tunnel (no direct network path needed).` };
    const allowed = await this.allowedHosts();
    if (!allowed.has(host)) throw new BadRequestException('host is not a known VM address');
    const reachable = await new Promise<boolean>((resolve) => {
      const s = new net.Socket();
      const done = (ok: boolean) => { s.destroy(); resolve(ok); };
      s.setTimeout(4000);
      s.once('connect', () => done(true));
      s.once('timeout', () => done(false));
      s.once('error', () => done(false));
      s.connect(port, host);
    });
    return {
      reachable,
      host,
      port,
      detail: reachable
        ? `Reachable on ${host}:${port}.`
        : (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
          ? `The MCMF server cannot reach ${host}:${port} — this is a private/LAN address and this MCMF server isn't on that network. Either open the console from an MCMF that IS on that LAN, or install the pure-outbound MCMF agent on the host (Help → Agents) — it tunnels the console out, so no inbound path is needed. (An old push-model agent does NOT tunnel; re-run the installer to switch it to outbound.)`
          : `The MCMF server cannot reach ${host}:${port}. Open that port to the server's IP (NSG / security group / firewall) and confirm the VM is running and the service is listening.`),
    };
  }

  /** guacamole-lite token format: base64(JSON({ iv, value: AES-256-CBC(payload) base64 })). */
  private encrypt(payload: unknown): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', guacKey(), iv);
    let enc = cipher.update(JSON.stringify(payload), 'utf8', 'base64');
    enc += cipher.final('base64');
    const data = { iv: iv.toString('base64'), value: enc };
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }
}
