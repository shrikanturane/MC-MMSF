import { Client } from 'ssh2';
import dgram from 'node:dgram';
import type { CloudAccountRef, CloudConnector, ControlContext, DiscoveredAsset, PowerAction, ProviderCredentials, TestResult } from './adapter';
import { runStages } from './adapter';

/** Send a Wake-on-LAN magic packet (UDP broadcast) — powers on a host on the same LAN. */
function wakeOnLan(mac: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = (mac || '').replace(/[^0-9a-fA-F]/g, '');
    if (clean.length !== 12) return reject(new Error(`invalid MAC address: ${mac}`));
    const macBuf = Buffer.from(clean, 'hex');
    const packet = Buffer.alloc(6 + 16 * 6, 0xff); // 6×0xFF sync stream, then MAC ×16
    for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);
    const sock = dgram.createSocket('udp4');
    sock.once('error', (e) => { try { sock.close(); } catch { /* */ } reject(e); });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, 0, packet.length, 9, '255.255.255.255', (err) => { try { sock.close(); } catch { /* */ } (err ? reject(err) : resolve()); });
    });
  });
}

/**
 * Agent-less host inventory via SSH (ported). Connects to a Linux/Windows-OpenSSH host and
 * gathers facts (hostname, kernel, cpus, memory, OS, live cpu/mem) — the host itself is
 * registered as a `vm:linux`/`vm:windows` asset. Credentials: { host, port?, username,
 * password? | privateKey? }.
 */
export class SshConnector implements CloudConnector {
  constructor(readonly provider: string) {}

  async test(credentials: ProviderCredentials): Promise<TestResult> {
    return runStages([
      {
        name: 'Validate inputs',
        run: async () => {
          if (!credentials.host || !credentials.username) throw new Error('host and username are required');
          if (!credentials.password && !credentials.privateKey) throw new Error('a password or private key is required');
          return `${credentials.username}@${credentials.host}:${credentials.port ?? 22}`;
        },
      },
      {
        name: 'SSH connect & authenticate',
        run: async () => {
          const out = await this.exec(credentials, 'echo OK; hostname');
          if (!out.includes('OK')) throw new Error('connected but probe command failed');
          return `Reached ${out.split('\n').filter(Boolean).pop() ?? credentials.host}`;
        },
      },
    ]);
  }

  async discover(_account: CloudAccountRef, credentials: ProviderCredentials): Promise<DiscoveredAsset[]> {
    if (!credentials.host || !credentials.username) {
      throw new Error('ssh connector requires { host, username }');
    }
    const out = await this.exec(
      credentials,
      [
        'printf "H=%s\\n" "$(hostname)"',
        'printf "K=%s\\n" "$(uname -sr 2>/dev/null)"',
        'printf "C=%s\\n" "$(nproc 2>/dev/null)"',
        'printf "M=%s\\n" "$(free -m 2>/dev/null | awk \'/Mem:/{print $2}\')"',
        'printf "U=%s\\n" "$(free -m 2>/dev/null | awk \'/Mem:/{printf "%.0f", $3/$2*100}\')"',
        'printf "L=%s\\n" "$(awk \'{print $1}\' /proc/loadavg 2>/dev/null)"',
        'printf "O=%s\\n" "$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"',
        'printf "A=%s\\n" "$(ip link 2>/dev/null | awk \'/ether/{print $2; exit}\')"',
      ].join('; '),
    );

    const f: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) f[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const hostname = f.H || credentials.host;
    const cpus = f.C ? Number(f.C) : undefined;
    const load = f.L ? Number(f.L) : undefined;
    return [
      {
        resourceType: this.provider === 'windows' ? 'vm:windows' : 'vm:linux',
        externalId: `${this.provider}:${credentials.host}:${credentials.port ?? 22}`,
        name: hostname,
        region: credentials.host,
        cpuPct: cpus && load != null ? Math.min(100, Math.round((load / cpus) * 100)) : undefined,
        memoryPct: f.U ? Number(f.U) : undefined,
        properties: {
          discoveredBy: 'ssh-connector',
          os: f.O || undefined,
          kernel: f.K || undefined,
          cpus,
          memoryMb: f.M ? Number(f.M) : undefined,
          loadAvg: load,
          mac: f.A || undefined,
        },
      },
    ];
  }

  /**
   * Power action on an SSH host. reboot/stop run over SSH (sudo where needed); start is only
   * possible via Wake-on-LAN (the host is off — can't SSH to it), which needs the NIC MAC and
   * the MCMF server on the same LAN/broadcast domain.
   */
  async control(action: PowerAction, ctx: ControlContext, credentials: ProviderCredentials): Promise<{ ok: boolean; detail: string }> {
    const isWin = this.provider === 'windows';
    if (action === 'start') {
      if (!ctx.mac) throw new Error('Power-on over SSH is not possible (the host is off). Re-sync to capture the NIC MAC for Wake-on-LAN, or use IPMI/iDRAC/the cloud console. WoL also requires MCMF on the same LAN with WoL enabled in the host BIOS/NIC.');
      await wakeOnLan(ctx.mac);
      return { ok: true, detail: `Wake-on-LAN magic packet sent to ${ctx.mac}. The host will power on if WoL is enabled in its BIOS/NIC and MCMF shares its LAN.` };
    }
    const cmd = action === 'reboot'
      ? (isWin ? 'shutdown /r /t 0' : 'sudo -n reboot 2>/dev/null || reboot')
      : (isWin ? 'shutdown /s /t 0' : 'sudo -n shutdown -h now 2>/dev/null || shutdown -h now');
    try {
      await this.exec(credentials, cmd);
    } catch (err) {
      // reboot/shutdown usually drops the SSH session before the command returns — that's success.
      const msg = String((err as Error)?.message ?? err);
      if (/timeout|closed|disconnect|ECONNRESET|ended/i.test(msg)) {
        return { ok: true, detail: `${action === 'reboot' ? 'Restart' : 'Power-off'} command sent to ${credentials.host}; the SSH session dropped as the host went down (expected).` };
      }
      throw new Error(isWin ? msg : `${msg} — the SSH user may need passwordless sudo for ${action === 'reboot' ? 'reboot' : 'shutdown'}.`);
    }
    return { ok: true, detail: `${action === 'reboot' ? 'Restart' : 'Power-off'} command executed on ${credentials.host}.` };
  }

  private exec(credentials: ProviderCredentials, command: string): Promise<string> {
    const conn = new Client();
    return new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error('ssh timeout'));
      }, 15_000);
      conn
        .on('ready', () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              clearTimeout(timer);
              conn.end();
              return reject(err);
            }
            stream
              .on('data', (d: Buffer) => (out += d.toString()))
              .on('close', () => {
                clearTimeout(timer);
                conn.end();
                resolve(out);
              });
          });
        })
        .on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        })
        .connect({
          host: credentials.host,
          port: credentials.port ? Number(credentials.port) : 22,
          username: credentials.username,
          ...(credentials.password ? { password: credentials.password } : {}),
          ...(credentials.privateKey ? { privateKey: credentials.privateKey } : {}),
          readyTimeout: 12_000,
        });
    });
  }
}
