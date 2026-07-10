import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Client } from 'ssh2';
import * as net from 'node:net';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { sysParams, pInt } from '../../system-params';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
import { PrismaService } from '../../prisma/prisma.service';
import { encryptJson, decryptJson } from '../../connectors/crypto';

/**
 * Current agent build version. Baked into every downloaded/served agent (__AGENT_VERSION__) and returned
 * on each ingest so an installed agent can self-update when it's older. BUMP THIS whenever the agent
 * scripts (mcmf-tray-agent.ps1 / mcmf-agent-linux.py / the installer) change.
 */
export const AGENT_VERSION = '1.7.0';

/** Shared agent ingest key (stable, derived from the app key unless overridden). */
function agentKey(): string {
  return (process.env.AGENT_KEY || String(process.env.APP_ENCRYPTION_KEY).slice(0, 24)).trim();
}

interface IngestBody {
  name?: string;
  machineId?: string;
  version?: string;
  hostname?: string;
  os?: string;
  osVersion?: string; // detailed OS caption, e.g. "Windows Server 2022" / "Ubuntu 22.04" (Phase 2 agents)
  ips?: string[];
  metrics?: { cpuPct?: number; memPct?: number; diskPct?: number; netMbps?: number; diskIoKbps?: number };
  services?: { name: string; status: string }[];
  openPorts?: (number | { port: number; proc?: string })[]; // listening ports (Windows agent already sends these)
  connections?: { raddr?: string; rport?: number; lport?: number; proc?: string; state?: string }[]; // established → remote IP (Phase 2)
  installedApps?: { name: string; version?: string }[]; // installed-software inventory (Phase 2)
  events?: { ts?: string; level?: string; category?: string; source?: string; message?: string }[];
  // Tray/endpoint agent extras — identity + device posture, consumed by the AAA / NAC step.
  loggedInUser?: string;
  posture?: Record<string, unknown>;
  // The tray agent sends metrics at the top level (not nested under `metrics`).
  cpuPct?: number;
  memPct?: number;
  diskPct?: number;
  netMbps?: number;
}

// Remote collector — single-quoted awk into shell vars, then printf (quote-safe). Most Linux.
const SSH_COLLECT = `
C1=$(awk '/^cpu /{print $2+$3+$4" "$5}' /proc/stat); sleep 1; C2=$(awk '/^cpu /{print $2+$3+$4" "$5}' /proc/stat)
CPU=$(awk -v a="$C1" -v b="$C2" 'BEGIN{split(a,x," ");split(b,y," ");du=y[1]-x[1];di=y[2]-x[2];d=du+di;if(d>0)printf "%.1f",du/d*100;else printf "0.0"}')
MEM=$(free | awk '/^Mem:/{if($2>0)printf "%.1f",$3/$2*100;else printf "0.0"}')
DISK=$(df -P / | awk 'NR==2{gsub("%","",$5);print $5}')
SVC=$(ps -eo comm=,pcpu=,pmem= --sort=-pcpu 2>/dev/null | head -15 | awk 'NF>=3{printf "%s:%s:%s;",$1,$2,$3}')
OSV=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"); [ -z "$OSV" ] && OSV=$(uname -sr)
KERN=$(uname -r)
PORTS=$(ss -tlnH 2>/dev/null | awk '{n=split($4,a,":");print a[n]}' | grep -E '^[0-9]+$' | sort -un | head -80 | tr '\\n' ',')
CONN=$(ss -tnH state established 2>/dev/null | awk '{l=$(NF-1);p=$NF;nl=split(l,la,":");np=split(p,pa,":");lp=la[nl];rp=pa[np];ra=substr(p,1,length(p)-length(rp)-1);if(ra!="")printf "%s|%s|%s;",lp,ra,rp}' | head -c 4000)
PKG=$(dpkg-query -W -f='\${Package}|\${Version};' 2>/dev/null | head -c 8000); [ -z "$PKG" ] && PKG=$(rpm -qa --qf '%{NAME}|%{VERSION};' 2>/dev/null | head -c 8000)
printf 'MCMFCPU=%s\\nMCMFMEM=%s\\nMCMFDISK=%s\\nMCMFSVC=%s\\n' "$CPU" "$MEM" "$DISK" "$SVC"
printf 'MCMFOSV=%s\\nMCMFKERN=%s\\nMCMFPORTS=%s\\nMCMFCONN=%s\\n' "$OSV" "$KERN" "$PORTS" "$CONN"
printf 'MCMFPKG=%s\\n' "$PKG"
echo MCMFEVT_START; journalctl -p warning -n 8 --no-pager -o cat 2>/dev/null; echo MCMFEVT_END
`;

// Windows collector — runs over OpenSSH as a base64 -EncodedCommand (no quoting issues).
const WINDOWS_PS = `
$ErrorActionPreference='SilentlyContinue'
$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$o=Get-CimInstance Win32_OperatingSystem
$mem=[math]::Round((1-$o.FreePhysicalMemory/$o.TotalVisibleMemorySize)*100,1)
$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$disk=[math]::Round((1-$d.FreeSpace/$d.Size)*100,1)
$tp=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; $nc=[Math]::Max(1,(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors)
$cm=@{}; try { (Get-Counter '\\Process(*)\\% Processor Time').CounterSamples | ForEach-Object { if($_.InstanceName -and $_.InstanceName -ne '_total' -and $_.InstanceName -ne 'idle'){ $cm[$_.InstanceName]=[math]::Round($_.CookedValue/$nc,1) } } } catch {}
$svc=((Get-Process | Group-Object ProcessName | ForEach-Object { $ws=($_.Group | Measure-Object WorkingSet64 -Sum).Sum; $c=[double]$cm[$_.Name.ToLower()]; $m=if($tp){[math]::Round($ws/$tp*100,1)}else{0}; [pscustomobject]@{n=$_.Name;c=$c;m=$m} } | Sort-Object c,m -Descending | Select-Object -First 15 | ForEach-Object { '{0}:{1}:{2}' -f $_.n,$_.c,$_.m }) -join ';')
Write-Output "MCMFCPU=$cpu"; Write-Output "MCMFMEM=$mem"; Write-Output "MCMFDISK=$disk"; Write-Output "MCMFSVC=$svc"; Write-Output "MCMFOSV=$($o.Caption)"
Write-Output "MCMFEVT_START"
Get-WinEvent -FilterHashtable @{LogName='System';Level=2,3} -MaxEvents 8 | ForEach-Object { ($_.Message -replace "\`r\`n"," ") }
Write-Output "MCMFEVT_END"
`;
function windowsPullCommand(): string {
  const b64 = Buffer.from(WINDOWS_PS, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
}

// The Windows install body (no dependencies): writes the (token-baked) tray-agent .ps1, opens the
// pull port in the firewall, and registers the SAME always-on tasks the .exe installer does — a
// SYSTEM service at boot (restart-on-failure) + a per-user logon tray task — then starts it. Needs
// local-admin rights. Emits MCMF_WIN_INSTALL=ok;state=<State> or MCMF_WIN_ERR=<msg>.
// Shared by the remote SSH push, the WMI/SMB push, and the copy-paste bootstrap one-liner.
function windowsInstallBody(key: string, mcmfIp: string, pullPort: number): string {
  const ps1b64 = Buffer.from(trayAgent(key, mcmfIp, pullPort), 'utf8').toString('base64');
  return `
$ErrorActionPreference='Stop'
try {
  # Clean upgrade — stop + remove ANY prior/legacy MCMF agent so only the outbound agent runs
  # (no duplicates, no stale push agent pinning outbound=false). Idempotent: safe on a fresh box.
  Get-ScheduledTask -TaskName 'MCMF*' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*mcmf-tray-agent*' -or $_.CommandLine -like '*mcmf-agent*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
  Unregister-ScheduledTask -TaskName 'MCMF Guest Agent' -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'MCMF Agent' -Confirm:$false -ErrorAction SilentlyContinue
  # Reuse the EXE installer's directory if present (it installs under "Program Files (x86)"), so a
  # self-update upgrades the SAME install in place instead of creating a second copy under "Program Files".
  $dir = if (Test-Path 'C:\\Program Files (x86)\\MCMF\\mcmf-tray-agent.ps1') { 'C:\\Program Files (x86)\\MCMF' } else { 'C:\\Program Files\\MCMF' }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $agent = Join-Path $dir 'mcmf-tray-agent.ps1'
  [System.IO.File]::WriteAllText($agent, [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ps1b64}')))
  $cfg = Join-Path $env:ProgramData 'MCMF'; New-Item -ItemType Directory -Force -Path $cfg | Out-Null
  try { & icacls $cfg /grant '*S-1-5-32-545:(OI)(CI)M' /T | Out-Null } catch {}
  # Trust the MCMF server's TLS cert in LocalMachine\\Root. The outbound console tunnel uses
  # ClientWebSocket, whose WinHTTP layer ignores the per-process cert-bypass callback — so without
  # this the WSS handshake to a self-signed MCMF rejects the cert and RDP/SSH hangs at "Connecting".
  try {
    [Net.ServicePointManager]::ServerCertificateValidationCallback={$true}
    try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12 } catch {}
    $rq=[Net.WebRequest]::Create('https://${mcmfIp}/'); $rq.Timeout=8000; try { $rq.GetResponse().Close() } catch {}
    $sc=$rq.ServicePoint.Certificate
    if ($sc) {
      $x=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,$sc.Export('Cert'))
      $store=New-Object System.Security.Cryptography.X509Certificates.X509Store 'Root','LocalMachine'
      $store.Open('ReadWrite'); if (-not ($store.Certificates | Where-Object { $_.Thumbprint -eq $x.Thumbprint })) { $store.Add($x) }; $store.Close()
    }
  } catch {}
  # Pure outbound — no inbound listener, so remove any legacy MCMF firewall rule and open NO port.
  try { & netsh advfirewall firewall delete rule name='MCMF Agent ${pullPort}' | Out-Null } catch {}
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $agent + '" -Service')
  $prn = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'MCMF Endpoint Agent (Service)' -Action $act -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $prn -Settings $set -Force | Out-Null
  $tact = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $agent + '"')
  $tprn = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Highest
  Register-ScheduledTask -TaskName 'MCMF Endpoint Agent' -Action $tact -Trigger (New-ScheduledTaskTrigger -AtLogon) -Principal $tprn -Force | Out-Null
  # All-users Start-menu + Desktop shortcuts so the agent has an app icon you can launch (e.g. after Exit).
  # Overwriting same-named .lnk keeps it idempotent — no duplicate icons on re-install.
  try {
    $ws = New-Object -ComObject WScript.Shell
    $psExe = (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    foreach ($loc in @([Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'))) {
      try {
        $lnk = $ws.CreateShortcut((Join-Path $loc 'MCMF Endpoint Agent.lnk'))
        $lnk.TargetPath = $psExe
        $lnk.Arguments = ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $agent + '"')
        $lnk.WorkingDirectory = $dir
        $lnk.IconLocation = 'shell32.dll,18'
        $lnk.Description = 'Start the MCMF Endpoint Agent (tray)'
        $lnk.Save()
      } catch {}
    }
  } catch {}
  Start-ScheduledTask -TaskName 'MCMF Endpoint Agent (Service)'
  # Relaunch the tray immediately (a self-update killed the old one) — runs the logon task now in the
  # interactive session, so the icon comes back without waiting for the next logon. Harmless if headless.
  try { Start-ScheduledTask -TaskName 'MCMF Endpoint Agent' -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Seconds 2
  $st = (Get-ScheduledTask -TaskName 'MCMF Endpoint Agent (Service)').State
  Write-Output ('MCMF_WIN_INSTALL=ok;state=' + $st)
} catch { Write-Output ('MCMF_WIN_ERR=' + $_.Exception.Message) }
`;
}
// Remote SSH push: run the install body over OpenSSH as a base64 -EncodedCommand (no quoting issues).
function windowsPushInstallCommand(key: string, mcmfIp: string, pullPort: number): string {
  const b64 = Buffer.from(windowsInstallBody(key, mcmfIp, pullPort), 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
}
// Zero-dependency bootstrap: a self-contained .ps1 an admin runs once on a fresh Windows box
// (no OpenSSH/WinRM/SMB needed). Delivered by GET /agent/bootstrap?k=<key>.
function windowsBootstrapScript(key: string, mcmfIp: string, pullPort: number): string {
  return `# MCMF Endpoint Agent — one-shot bootstrap. Run in an ELEVATED PowerShell (Run as administrator).\n`
    + `Write-Host 'Installing the MCMF Endpoint Agent (always-on service + tray)...'\n`
    + windowsInstallBody(key, mcmfIp, pullPort)
    + `\nif ($Global:LASTEXITCODE) {} ; Write-Host ('Done — reporting to ${mcmfIp}; the service starts on every boot. Listener on TCP ${pullPort}.')\n`;
}

@Injectable()
export class AgentService implements OnModuleInit {
  private readonly log = new Logger('Agent');
  private pulling = false;
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Agentless SSH pull loop: MCMF → VM (works when MCMF is private and VMs can't reach it).
    setTimeout(() => this.pullDue().catch(() => undefined), 12_000);
    setInterval(() => this.pullDue().catch(() => undefined), 30_000);
    // Retention: drop guest agents (and their auto-created fleet resources) that stopped reporting.
    setTimeout(() => this.pruneStaleGuests().catch(() => undefined), 60_000);
    setInterval(() => this.pruneStaleGuests().catch(() => undefined), 6 * 3600_000);
  }

  assertKey(key?: string) {
    // Constant-time comparison — a plain `!==` leaks the key via response-timing.
    const expected = agentKey();
    const a = Buffer.from(String(key ?? ''));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('invalid agent key');
  }

  /**
   * Guest-agent retention: a push/endpoint agent that stops sending data is removed after N days
   * (default 14, env GUEST_AGENT_RETENTION_DAYS), along with the fleet Resource it created. Pull
   * TARGETS that an admin enrolled (ssh-pull / http-pull) are left alone — only their stale
   * auto-created resource is pruned (it reappears when the target reports again).
   */
  private async pruneStaleGuests() {
    const days = pInt(await sysParams(this.prisma), 'agentRetentionDays', 'GUEST_AGENT_RETENTION_DAYS', 14);
    const cutoff = new Date(Date.now() - days * 24 * 3600_000);
    let agents = { count: 0 };
    let res = { count: 0 };
    try { agents = await this.prisma.agent.deleteMany({ where: { mode: 'push', lastSeenAt: { lt: cutoff } } }); } catch (e) { this.log.warn(`prune agents: ${String(e)}`); }
    try { res = await this.prisma.resource.deleteMany({ where: { source: 'agent', lastSeenAt: { lt: cutoff } } }); } catch (e) { this.log.warn(`prune resources: ${String(e)}`); }
    if (agents.count || res.count) this.log.log(`retention: removed ${agents.count} stale guest agent(s) + ${res.count} fleet resource(s) (no data > ${days}d)`);
  }

  /** Admin: enroll an agentless SSH-pull target (MCMF connects out and collects). */
  async enrollPull(userId: string, body: { host?: string; altHosts?: unknown; port?: number; username?: string; password?: string; intervalSec?: number; os?: string; mode?: string; pullKey?: string; group?: string }) {
    const host = String(body?.host ?? '').trim();
    const altHosts = cleanHosts(body?.altHosts).filter((h) => h !== host).join(',');
    const os = String(body?.os ?? 'linux').toLowerCase().includes('win') ? 'windows' : 'linux';
    const intervalSec = Math.min(3600, Math.max(30, Number(body?.intervalSec || 120)));
    const ipsArr = [host, ...altHosts.split(',').filter(Boolean)];
    const ipsCsv = ipsArr.join(',');

    // ── HTTP-pull (exe/PowerShell agent listening on a custom port) ──
    if (String(body?.mode ?? '').toLowerCase() === 'http-pull') {
      if (!host) throw new BadRequestException('host is required');
      const port = Number(body?.port || 9182);
      const pullKey = (String(body?.pullKey ?? '').trim()) || agentKey();
      const existing = await this.prisma.agent.findFirst({ where: { hostname: host, mode: 'http-pull' } });
      if (existing) await this.prisma.agent.update({ where: { id: existing.id }, data: { port, intervalSec, active: true, ips: ipsCsv, altHosts, os, ownerId: userId, pullKey } });
      else await this.prisma.agent.create({ data: { name: host, hostname: host, ips: ipsCsv, altHosts, os, mode: 'http-pull', port, intervalSec, active: true, ownerId: userId, pullKey } });
      // Mirror into the IP/Host Monitor (group-based) so it shows in the monitoring stack.
      await this.ensureMonitor(host, altHosts, 'tcp', port, body?.group);
      this.pullTcpFailover(ipsArr, port, pullKey, os).catch((e) => this.log.warn(`http-pull ${host}: ${String(e)}`));
      return { ok: true, pullKey };
    }

    // ── SSH-pull (default) ──
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    const port = Number(body?.port || 22);
    if (!host || !username || !password) throw new BadRequestException('host, username and password are required');

    // Store the credential in the enrolling user's vault; the background pull uses it.
    await this.prisma.vmCredential.upsert({
      where: { userId_host_protocol: { userId, host, protocol: 'ssh' } },
      update: { username, password: encryptJson(password), kind: 'vm' },
      create: { userId, host, protocol: 'ssh', username, password: encryptJson(password), kind: 'vm' },
    });
    const existing = await this.prisma.agent.findFirst({ where: { hostname: host, mode: 'ssh-pull' } });
    if (existing) await this.prisma.agent.update({ where: { id: existing.id }, data: { port, intervalSec, active: true, ips: ipsCsv, altHosts, os, ownerId: userId } });
    else await this.prisma.agent.create({ data: { name: host, hostname: host, ips: ipsCsv, altHosts, os, mode: 'ssh-pull', port, intervalSec, active: true, ownerId: userId } });

    // Mirror into the IP/Host Monitor (group-based) so it shows in the monitoring stack.
    await this.ensureMonitor(host, altHosts, 'tcp', port, body?.group);

    // Immediate first pull (failover across all IPs) so the user sees data without waiting.
    this.pullFailover(ipsArr, port, username, password, os).catch((e) => this.log.warn(`pull ${host}: ${String(e)}`));
    return { ok: true };
  }

  /**
   * Ensure an enrolled pull target also exists as an IP/Host Monitor so the complete
   * monitoring + management stack reflects it. Monitoring is group-based, so the caller
   * supplies the group. A TCP check on the same port we pull from is the truest reachability
   * signal (ping is often blocked on private-cloud VMs). Existing monitors keep their type/port
   * — we only refresh failover IPs and the group.
   */
  private async ensureMonitor(host: string, altHosts: string, type: string, port: number, group?: string) {
    if (!host) return;
    const g = (String(group ?? '').trim()) || 'default';
    const existing = await this.prisma.monitor.findFirst({ where: { target: host } });
    if (existing) {
      await this.prisma.monitor.update({ where: { id: existing.id }, data: { altTargets: altHosts, group: g } }).catch((e) => this.log.warn(`monitor mirror ${host}: ${String(e)}`));
    } else {
      await this.prisma.monitor.create({ data: { name: host, target: host, altTargets: altHosts, type, port, group: g, enabled: true } }).catch((e) => this.log.warn(`monitor mirror ${host}: ${String(e)}`));
    }
  }

  /** Try each IP until the TCP agent answers — the exe/PowerShell agent pull path. */
  private async pullTcpFailover(hosts: string[], port: number, key: string, os: string) {
    let lastErr: unknown;
    for (const h of hosts.filter(Boolean)) {
      try { await this.pullTcp(h, port, key, os); return; }
      catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('no reachable IP');
  }

  /** Raw-TCP pull (no HTTP): connect, send "AUTH <key>", read one JSON line of telemetry, ingest it. */
  private pullTcp(host: string, port: number, key: string, os: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      let buf = '';
      let done = false;
      const finish = (err?: Error) => {
        if (done) return; done = true;
        try { sock.destroy(); } catch { /* */ }
        if (err) return reject(err);
        const line = buf.split('\n').find((l) => l.trim().startsWith('{')) ?? '';
        let j: any;
        try { j = JSON.parse(line); } catch { return reject(new Error('agent returned no telemetry')); }
        if (j?.error) return reject(new Error(String(j.error)));
        // IMPORTANT: key the agent row by the enroll IP we connected to (hostname: host), NOT the
        // agent's self-reported hostname — otherwise ingest() can't match the enrolled row and
        // creates a duplicate, leaving the IP-keyed row (which the UI shows) forever stale.
        // The real hostname is kept in `name` for display. (SSH pull does the same: hostname=IP.)
        const ipList = Array.isArray(j?.ips) && j.ips.length ? [host, ...j.ips.map(String)] : [host];
        this.ingest({
          name: j?.hostname ?? host, hostname: host, os: j?.os ?? os, ips: [...new Set(ipList)],
          metrics: { cpuPct: Number(j?.cpuPct), memPct: Number(j?.memPct), diskPct: Number(j?.diskPct), netMbps: Number(j?.netMbps), diskIoKbps: Number(j?.diskIoKbps) },
          services: Array.isArray(j?.services) ? j.services : [],
          events: Array.isArray(j?.events) ? j.events : [],
        }).then(() => resolve()).catch(reject);
      };
      sock.setTimeout(12_000, () => finish(new Error('tcp timeout')));
      sock.on('connect', () => sock.write(`AUTH ${key}\n`));
      sock.on('data', (d) => { buf += d.toString(); if (buf.includes('\n') && buf.includes('}')) finish(); });
      sock.on('error', (e) => finish(e as Error));
      sock.on('close', () => finish());
    });
  }

  /** Try each IP (public/private) until one SSH connection succeeds — better reachability. */
  private async pullFailover(hosts: string[], port: number, username: string, password: string, os: string) {
    let lastErr: unknown;
    for (const h of hosts.filter(Boolean)) {
      try { await this.pullOne(h, port, username, password, os); return; }
      catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('no reachable IP');
  }

  /** Run due pulls — both SSH-pull and HTTP-agent-pull targets. */
  private async pullDue() {
    if (this.pulling) return;
    this.pulling = true;
    try {
      const now = Date.now();
      const targets = await this.prisma.agent.findMany({ where: { mode: { in: ['ssh-pull', 'http-pull'] }, active: true } });
      for (const t of targets) {
        if (t.lastSeenAt && now - t.lastSeenAt.getTime() < t.intervalSec * 1000) continue;
        const hosts = [t.hostname ?? '', ...String(t.altHosts ?? '').split(',').filter(Boolean)];
        if (t.mode === 'http-pull') {
          await this.pullTcpFailover(hosts, t.port, t.pullKey, t.os ?? 'windows').catch((e) => this.log.warn(`http-pull ${t.hostname}: ${String((e as Error)?.message ?? e)}`));
          continue;
        }
        const cred = await this.prisma.vmCredential.findUnique({ where: { userId_host_protocol: { userId: t.ownerId, host: t.hostname ?? '', protocol: 'ssh' } } });
        if (!cred) { this.log.warn(`ssh-pull ${t.hostname}: no saved SSH credentials`); continue; }
        let pw = '';
        try { pw = decryptJson<string>(cred.password); } catch { continue; }
        await this.pullFailover(hosts, t.port, cred.username, pw, t.os ?? 'linux').catch((e) => this.log.warn(`ssh-pull ${t.hostname}: ${String((e as Error)?.message ?? e)}`));
      }
    } finally {
      this.pulling = false;
    }
  }

  /** On-demand pull for one agent (the per-VM "Pull now" button). Returns the refreshed agent. */
  async pullNow(id: string) {
    const t = await this.prisma.agent.findUnique({ where: { id } });
    if (!t) throw new BadRequestException('agent not found');
    const ipList = String(t.ips ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const hosts = [...new Set([t.hostname ?? '', ...ipList, ...String(t.altHosts ?? '').split(',')].map((s) => s.trim()).filter(Boolean))];
    if (t.mode === 'http-pull' || t.mode === 'push') {
      // http-pull and the Windows/endpoint PUSH agent both expose the raw-TCP pull listener
      // ("AUTH <key>"). A pull both TESTS reachability+liveness and refreshes telemetry on success.
      const key = t.pullKey || agentKey();
      // The agent's pull listener is 9182 by default. Never probe TCP 22 — that's SSH, not the agent
      // (push agents are often stored with port=22 from enrollment).
      const port = t.port && t.port !== 22 ? t.port : 9182;
      try {
        await this.pullTcpFailover(hosts, port, key, t.os ?? 'windows');
        return { ok: true, reachable: true, message: 'Reached the agent and pulled fresh telemetry ✓', agent: await this.prisma.agent.findUnique({ where: { id } }) };
      } catch (e) {
        const why = String((e as Error)?.message ?? e).slice(0, 160);
        if (t.mode === 'push') {
          // Push agents normally sit behind NAT/firewall, so an inbound pull legitimately fails —
          // that does NOT mean the agent is broken, only that MCMF can't reach it to pull.
          return { ok: true, reachable: false, message: `Couldn't reach the agent's listener on TCP ${port} (${why}). This agent reports by PUSH, so an inbound test can fail behind NAT/firewall. If it isn't appearing at all, its background service isn't running — re-install with the always-on installer (Help → Agents) and reboot once.` };
        }
        throw new BadRequestException(`pull failed: ${why}`);
      }
    }
    if (t.mode !== 'ssh-pull') throw new BadRequestException('only pull agents can be refreshed on demand');
    const cred = await this.prisma.vmCredential.findUnique({ where: { userId_host_protocol: { userId: t.ownerId, host: t.hostname ?? '', protocol: 'ssh' } } });
    if (!cred) throw new BadRequestException('no saved SSH credentials for this host — re-enroll the SSH pull target');
    let pw = '';
    try { pw = decryptJson<string>(cred.password); } catch { throw new BadRequestException('stored credential could not be decrypted'); }
    await this.pullFailover(hosts, t.port, cred.username, pw, t.os ?? 'linux');
    const updated = await this.prisma.agent.findUnique({ where: { id } });
    return { ok: true, agent: updated };
  }

  /**
   * Remotely PUSH-install the guest agent onto a Linux target over SSH (using the stored
   * credentials), then pull from it. For a private MCMF the installed agent is a raw-TCP
   * listener (same protocol as the Windows .exe agent) — MCMF connects IN and pulls. We only
   * switch the target over after a successful verification pull, so a blocked port never
   * silently kills the working SSH-pull.
   */
  async pushAgent(userId: string, id: string, body: { port?: number; username?: string; password?: string } = {}) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new BadRequestException('agent not found');
    const os = (agent.os ?? 'linux').toLowerCase();
    const isWin = os.includes('win');
    const host = (agent.hostname ?? '').trim();
    if (!host) throw new BadRequestException('agent has no host');
    const ipList = String(agent.ips ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const hosts = [...new Set([host, ...ipList, ...String(agent.altHosts ?? '').split(',').map((s) => s.trim())].filter(Boolean))];
    const sshPort = agent.mode === 'ssh-pull' ? agent.port : 22;

    // SSH credentials: stored vault credential (owner) unless overridden in the request body.
    let username = String(body.username ?? '').trim();
    let password = String(body.password ?? '');
    if (!username || !password) {
      const owner = agent.ownerId || userId;
      const cred = await this.prisma.vmCredential.findUnique({ where: { userId_host_protocol: { userId: owner, host, protocol: 'ssh' } } });
      if (!cred) throw new BadRequestException('no saved SSH credentials for this host — enroll SSH pull first, or pass a username/password');
      username = cred.username;
      try { password = decryptJson<string>(cred.password); } catch { throw new BadRequestException('stored SSH credential could not be decrypted'); }
    }

    const key = agent.pullKey || agentKey();

    // ── Windows: install the always-on agent over SSH (OpenSSH + PowerShell) ──────────────
    if (isWin) {
      const winPort = Math.min(65535, Math.max(1, Number(body.port) || 9182));
      const base = (process.env.SSO_BASE_URL || 'https://localhost').replace(/\/$/, '');
      const mcmfIp = base.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
      const wcmd = windowsPushInstallCommand(key, mcmfIp, winPort);
      let wout = ''; let winHost = ''; let werr: unknown;
      for (const h of hosts.filter(Boolean)) {
        try { wout = await sshExec(h, sshPort, username, password, wcmd); winHost = h; break; }
        catch (e) { werr = e; }
      }
      if (!winHost) throw new BadRequestException(`Couldn't SSH into the Windows host to install (${String((werr as Error)?.message ?? werr)}). Remote install needs OpenSSH Server enabled on the host (listening on TCP ${sshPort}); if it's not, run the installer locally from Help → Agents.`);
      const failMsg = (wout.match(/MCMF_WIN_ERR=(.*)/) ?? [])[1]?.trim();
      if (failMsg) throw new BadRequestException(`The agent install ran on ${winHost} but failed: ${failMsg}`);
      if (!/MCMF_WIN_INSTALL=ok/.test(wout)) throw new BadRequestException(`Install command produced no success marker on ${winHost} (is the SSH user a local administrator?). Output: ${wout.slice(0, 200)}`);
      const state = (wout.match(/state=(\w+)/) ?? [])[1] ?? 'Running';
      await this.prisma.agent.update({ where: { id }, data: { os: 'windows', active: true, pullKey: key, port: winPort } }).catch(() => undefined);
      return { ok: true, verified: true, install: 'always-on service (boot + restart-on-failure)', port: winPort, host: winHost, message: `Always-on agent installed on ${winHost} over SSH (service: ${state}). It pushes telemetry to MCMF within ~1 min and on every boot — no logon needed. Pull listener on TCP ${winPort}.` };
    }

    const agentPort = Math.min(65535, Math.max(1, Number(body.port || (agent.mode === 'http-pull' ? agent.port : 0) || 9182)));
    const b64 = Buffer.from(linuxTcpAgent(agentPort, key), 'utf8').toString('base64');
    const cmd = linuxPushInstallCommand(agentPort, b64);

    // Install over SSH (failover across the host's IPs — public/private).
    let out = ''; let installedHost = ''; let lastErr: unknown;
    for (const h of hosts.filter(Boolean)) {
      try { out = await sshExec(h, sshPort, username, password, cmd); installedHost = h; break; }
      catch (e) { lastErr = e; }
    }
    if (!installedHost) throw new BadRequestException(`could not SSH to the host to install the agent: ${String((lastErr as Error)?.message ?? lastErr)}`);
    if (out.includes('MCMF_ERR=python3_missing')) throw new BadRequestException('python3 is not installed on the target — install python3 (apt/yum install python3) and retry');
    const install = out.includes('MCMF_INSTALL=systemd')
      ? 'systemd service (auto-starts on boot)'
      : out.includes('MCMF_INSTALL=nohup') ? 'background process (no passwordless sudo — will not survive reboot)' : 'process';

    // Verify MCMF can pull from the freshly installed agent over raw TCP before switching modes.
    let verified = false; let verr = '';
    try { await this.pullTcpFailover(hosts, agentPort, key, 'linux'); verified = true; }
    catch (e) { verr = String((e as Error)?.message ?? e); }

    if (verified) {
      await this.prisma.agent.update({ where: { id }, data: { mode: 'http-pull', port: agentPort, pullKey: key, os: 'linux', active: true } });
      await this.prisma.monitor.updateMany({ where: { target: host }, data: { type: 'tcp', port: agentPort } }).catch(() => undefined);
      return { ok: true, verified: true, install, port: agentPort, host: installedHost, message: `Agent installed as ${install} on ${installedHost}:${agentPort} and MCMF pulled telemetry successfully. This target now reports via the installed agent.` };
    }
    // Not verified — use the on-host diagnostics to give an accurate reason. SSH pull is left
    // running either way so monitoring continues.
    const listening = out.includes('MCMF_LISTEN=yes');   // listening from WITHIN the host (python self-test)
    const cron = out.includes('MCMF_CRON=yes');           // per-minute watchdog installed (no-sudo path)
    const refused = /ECONNREFUSED|refused/i.test(verr);    // RST = process already gone, not a firewall
    const log = ((out.split('MCMF_LOG_START')[1] ?? '').split('MCMF_LOG_END')[0] ?? '').trim().slice(0, 300);
    const cronNote = cron
      ? ' A per-minute cron watchdog was installed (cron-launched processes survive logout) — wait ~60s and click "Pull now"; it should come up on its own.'
      : ' Most reliable fix: grant this host’s SSH user passwordless sudo so MCMF installs a systemd service (auto-restart, reboot-proof), then click "⬇ Push agent" again.';

    if (listening) {
      // The agent bound the port from inside the host. Why can't MCMF reach it?
      if (refused) {
        // RST = the process is already gone — reaped when the SSH session closed (logout kill).
        return { ok: true, verified: false, install, port: agentPort, host: installedHost, message: `Agent started and was listening on ${installedHost}:${agentPort}, but the process was killed when the SSH session closed (this host runs systemd-logind with KillUserProcesses=yes, which nohup cannot escape).${cronNote} SSH pull is left running so monitoring continues.` };
      }
      // Connection timed out → a firewall is dropping inbound packets to the port.
      return { ok: true, verified: false, install, port: agentPort, host: installedHost, message: `Agent is installed and LISTENING on ${installedHost}:${agentPort}, but MCMF couldn't connect (${verr}) — a firewall is blocking it. Open inbound TCP ${agentPort} to this host (cloud NSG/security-group + OS firewall: "sudo ufw allow ${agentPort}/tcp"), then click "Pull now". SSH pull is left running so monitoring continues.` };
    }
    // Never bound from inside the host → a real start error (or killed within 2s); surface the log.
    const why = log ? ` Agent log: ${log}` : ' (no error output — the process was killed almost immediately, typically by systemd-logind KillUserProcesses=yes).';
    return { ok: true, verified: false, install, port: agentPort, host: installedHost, message: `Agent copied to ${installedHost} but it never started listening on TCP ${agentPort}.${why}${cronNote} SSH pull is left running so monitoring continues.` };
  }

  /** SSH into one host, collect telemetry, and store it (same path as push ingest). */
  private async pullOne(host: string, port: number, username: string, password: string, os = 'linux') {
    const cmd = os === 'windows' ? windowsPullCommand() : SSH_COLLECT;
    const out = await sshExec(host, port, username, password, cmd);
    const get = (k: string) => (out.match(new RegExp(`MCMF${k}=(.*)`)) ?? [])[1]?.trim();
    const evt = (out.split('MCMFEVT_START')[1] ?? '').split('MCMFEVT_END')[0] ?? '';
    const events = evt.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).map((m) => ({ level: 'warning', category: 'system', message: m.slice(0, 300) }));
    // Top processes "name:cpu:mem;…" (Task-Manager style); tolerate the legacy comma-name format.
    const svcRaw = get('SVC') ?? '';
    const services = (svcRaw.includes(':') ? svcRaw.split(';') : svcRaw.split(','))
      .map((s) => s.trim())
      .filter(Boolean)
      .map((tok) => {
        const [name, cpu, mem] = tok.split(':');
        return { name, cpu: Number(cpu) || 0, mem: Number(mem) || 0, status: 'running' };
      })
      .filter((s) => s.name);
    // OS inventory: detailed version, listening ports, established connections (pipe-delimited to
    // survive IPv6 colons), and installed packages. All best-effort — absent on minimal hosts.
    const osVersion = get('OSV') || undefined;
    const openPorts = (get('PORTS') || '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0 && n < 65536).slice(0, 200);
    const connections = (get('CONN') || '').split(';').map((s) => s.trim()).filter(Boolean).map((tok) => { const p = tok.split('|'); return { lport: Number(p[0]) || 0, raddr: p[1] || '', rport: Number(p[2]) || 0, state: 'established' }; }).filter((c) => c.raddr).slice(0, 200);
    const installedApps = (get('PKG') || '').split(';').map((s) => s.trim()).filter(Boolean).map((tok) => { const p = tok.split('|'); return { name: p[0], version: p[1] || '' }; }).filter((a) => a.name).slice(0, 400);
    await this.ingest({
      name: host, hostname: host, os, ips: [host], osVersion,
      metrics: { cpuPct: Number(get('CPU')), memPct: Number(get('MEM')), diskPct: Number(get('DISK')) },
      services, events, openPorts, connections, installedApps,
    });
    // Keep the ssh-pull mode/port on the record (ingest writes mode='push' implicitly otherwise).
    await this.prisma.agent.updateMany({ where: { hostname: host }, data: { mode: 'ssh-pull', port } }).catch(() => undefined);
  }

  /** Receive a telemetry+events report: update the agent, match a Resource, store SIEM events. */
  async ingest(body: IngestBody) {
    const hostname = (body.hostname || body.name || 'unknown').trim();
    const ips = (body.ips ?? []).map((s) => String(s).trim()).filter(Boolean);
    // Tray agent reports metrics at the top level; the SSH/exe collectors nest them under `metrics`.
    const m = { ...(body.metrics ?? {}), ...(body.cpuPct != null ? { cpuPct: body.cpuPct } : {}), ...(body.memPct != null ? { memPct: body.memPct } : {}), ...(body.diskPct != null ? { diskPct: body.diskPct } : {}), ...(body.netMbps != null ? { netMbps: body.netMbps } : {}) };

    // Match a discovered Resource to mirror metrics onto — by HOSTNAME or PUBLIC IP only.
    // Private IPs (10.x / 192.168.x / 172.16.x) collide across networks (e.g. two VMs both 10.0.0.5),
    // so matching on them cross-contaminates unrelated machines — never match on private IPs.
    const hn = hostname.toLowerCase();
    const resources = await this.prisma.resource.findMany({ where: { type: 'compute' } });
    const match = resources.find((r) => {
      const p = (r.properties as any) ?? {};
      return r.name.toLowerCase() === hn || (p.publicIp && ips.includes(p.publicIp));
    });

    // Dedup on RE-INSTALL: match the SAME machine by its stable machineId first, then fall back to
    // hostname. This stops a fresh install from creating a duplicate agent row for the same host.
    const machineId = String(body.machineId ?? '').trim() || null;
    const existing = machineId
      ? (await this.prisma.agent.findFirst({ where: { machineId } })) ?? (await this.prisma.agent.findFirst({ where: { hostname, machineId: null } }))
      : await this.prisma.agent.findFirst({ where: { hostname } });
    const data = {
      name: body.name || hostname,
      ...(machineId ? { machineId } : {}),
      ...(body.version ? { version: String(body.version).slice(0, 32) } : {}),
      hostname,
      os: body.os ?? null,
      ...(body.osVersion != null ? { osVersion: String(body.osVersion).slice(0, 120) } : {}),
      ips: ips.join(','),
      resourceId: match?.id ?? null,
      cpuPct: num(m.cpuPct),
      memPct: num(m.memPct),
      diskPct: num(m.diskPct),
      netMbps: num(m.netMbps),
      diskIoKbps: num(m.diskIoKbps),
      services: (body.services ?? []).slice(0, 50) as any,
      // OS-inventory drill-down: listening ports (already sent by the Windows agent), established
      // connections → remote IP, and installed-software inventory (the last two from Phase 2 agents).
      ...(Array.isArray(body.openPorts) ? { openPorts: body.openPorts.slice(0, 200) as any } : {}),
      ...(Array.isArray(body.connections) ? { connections: body.connections.slice(0, 300) as any } : {}),
      ...(Array.isArray(body.installedApps) ? { installedApps: body.installedApps.slice(0, 500) as any } : {}),
      // Endpoint identity + posture (for the AAA / NAC step). Stored as-is when the agent sends them.
      ...(body.loggedInUser != null ? { loggedInUser: String(body.loggedInUser).slice(0, 200) } : {}),
      ...(body.posture != null ? { posture: body.posture as any } : {}),
      lastSeenAt: new Date(),
    };
    // Don't reactivate a decommissioned agent: preserve its active flag.
    const agent = existing
      ? await this.prisma.agent.update({ where: { id: existing.id }, data })
      : await this.prisma.agent.create({ data });
    // Clean up any pre-existing duplicates for this machine (older rows by the same machineId/hostname).
    if (machineId) {
      await this.prisma.agent.deleteMany({ where: { id: { not: agent.id }, OR: [{ machineId }, { hostname, machineId: null }] } }).catch(() => undefined);
    }

    // Issue a per-agent token on first check-in (rotatable/revocable). The agent adopts it and presents
    // it INSTEAD of the shared bootstrap key thereafter, so one leaked agent key no longer authenticates
    // the whole fleet. The shared key is still accepted alongside (assertKeyOrToken), so agents that
    // haven't adopted a token yet keep working — zero breakage.
    let agentToken: string | null = (agent as any).token ?? null;
    if (!agentToken) {
      agentToken = randomBytes(24).toString('base64url');
      await this.prisma.agent.update({ where: { id: agent.id }, data: { token: agentToken } as any }).catch(() => { agentToken = null; });
    }

    // Unify the agent host into the fleet: mirror onto its matched cloud Resource, or — when it's an
    // endpoint/guest-agent host with no cloud match — create a first-class Resource so it shows in the
    // VM list + inventory + Monitoring and can be monitored & secured like everything else.
    const provider = String(body.os ?? '').toLowerCase().includes('win') ? 'windows' : 'linux';
    const primaryIp = ips[0] ?? hostname;
    const extra = {
      ...(body.loggedInUser != null ? { loggedInUser: String(body.loggedInUser) } : {}),
      ...(body.posture != null ? { posture: body.posture } : {}),
    };
    if (match) {
      await this.prisma.resource
        .update({
          where: { id: match.id },
          data: {
            cpuPct: data.cpuPct ?? match.cpuPct,
            memoryPct: data.memPct ?? match.memoryPct,
            diskPct: data.diskPct ?? (match as any).diskPct,
            networkMbps: data.netMbps ?? (match as any).networkMbps,
            status: 'running' as any,
            lastSeenAt: new Date(),
            properties: { ...((match.properties as any) ?? {}), diskPct: data.diskPct, services: data.services, agentReported: true, ...extra },
          },
        })
        .catch((e) => this.log.warn(`resource mirror: ${String(e)}`));
    } else {
      const extId = `agent:${hostname}`;
      const props = { os: body.os ?? null, ips, privateIp: ips[0] ?? null, services: data.services, diskPct: data.diskPct, agentReported: true, agentSource: true, ...extra };
      const res = await this.prisma.resource
        .upsert({
          where: { externalId: extId },
          create: {
            name: hostname, externalId: extId, provider: provider as any, type: 'compute' as any, region: primaryIp,
            status: 'running' as any, service: 'Guest Agent', source: 'agent',
            cpuPct: data.cpuPct ?? 0, memoryPct: data.memPct ?? 0, diskPct: data.diskPct, networkMbps: data.netMbps,
            properties: props as any, lastSeenAt: new Date(),
          },
          update: {
            provider: provider as any, region: primaryIp, status: 'running' as any,
            cpuPct: data.cpuPct ?? 0, memoryPct: data.memPct ?? 0, diskPct: data.diskPct, networkMbps: data.netMbps,
            properties: props as any, lastSeenAt: new Date(),
          },
        })
        .catch((e) => { this.log.warn(`agent resource upsert: ${String(e)}`); return null as any; });
      if (res) await this.prisma.agent.update({ where: { id: agent.id }, data: { resourceId: res.id } }).catch(() => undefined);
    }

    // Store events into the SIEM stream (capped per report).
    const events = (body.events ?? []).slice(0, 50);
    if (events.length) {
      await this.prisma.siemEvent.createMany({
        data: events.map((e) => ({
          ts: e.ts ? new Date(e.ts) : new Date(),
          source: e.source || hostname,
          host: hostname,
          level: ['info', 'warning', 'error', 'critical'].includes(String(e.level)) ? String(e.level) : 'info',
          category: String(e.category || 'system'),
          message: String(e.message || '').slice(0, 1000),
        })),
      }).catch((e) => this.log.warn(`siem insert: ${String(e)}`));
    }

    // The response tells the agent whether to keep running and how often to report.
    // Exiting requires an admin to decommission (active=false) — or root stopping the service.
    // agentVersion lets the agent self-update when it's older than the server's current build.
    return { ok: true, agentId: agent.id, agentToken, agentVersion: AGENT_VERSION, matchedResource: match?.name ?? null, events: events.length, active: agent.active, intervalSec: agent.intervalSec };
  }

  /**
   * Accept EITHER the shared bootstrap key (constant-time) OR a per-agent token issued on check-in.
   * Backward-compatible: agents still presenting the shared key authenticate exactly as before.
   */
  async assertKeyOrToken(key?: string): Promise<void> {
    const k = String(key ?? '');
    const expected = agentKey();
    const a = Buffer.from(k);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return;
    if (k.length >= 24) {
      const found = await this.prisma.agent.findFirst({ where: { token: k }, select: { id: true } }).catch(() => null);
      if (found) return;
    }
    throw new UnauthorizedException('invalid agent key');
  }

  /** Admin: change reporting interval or decommission (active=false → agent self-exits). */
  async update(id: string, body: { active?: boolean; intervalSec?: number; host?: string; altHosts?: unknown; port?: number; username?: string; password?: string; os?: string; displayName?: string; group?: string }) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new BadRequestException('agent not found');
    const data: any = {};
    if (typeof body?.active === 'boolean') data.active = body.active;
    // Operator-typed display name (overrides the VM hostname in the UI); '' clears it back to the hostname.
    if (body?.displayName !== undefined) data.displayName = String(body.displayName).trim() || null;
    // Move the agent to a different group. The group is NOT a column on Agent — it lives on the
    // mirrored IP/Host Monitor (Guest Agents + IP/Host Monitor share one group scope), and the
    // agent's displayed group is derived from that monitor. So update the monitor's group only.
    if (body?.group !== undefined) {
      const g = String(body.group).trim() || 'default';
      const host = agent.hostname || (agent.ips ? agent.ips.split(',')[0] : '');
      if (host) await this.ensureMonitor(host, agent.altHosts ?? '', 'tcp', agent.port ?? 22, g).catch(() => undefined);
    }
    if (body?.intervalSec && Number(body.intervalSec) >= 10) data.intervalSec = Math.min(3600, Number(body.intervalSec));
    if (body?.port) data.port = Number(body.port);
    if (body?.os) data.os = String(body.os).toLowerCase().includes('win') ? 'windows' : 'linux';

    // SSH-pull edit: change IP(s) and/or credentials.
    const newHost = body?.host !== undefined ? String(body.host).trim() : undefined;
    const altList = body?.altHosts !== undefined ? cleanHosts(body.altHosts) : undefined;
    if (agent.mode === 'ssh-pull' && (newHost || altList !== undefined || body?.username || body?.password)) {
      const finalHost = newHost || agent.hostname || '';
      const finalAlt = (altList ?? String(agent.altHosts ?? '').split(',')).map((h) => h.trim()).filter((h) => h && h !== finalHost);
      data.hostname = finalHost;
      data.name = finalHost;
      data.altHosts = finalAlt.join(',');
      data.ips = [finalHost, ...finalAlt].join(',');

      // Re-seal credentials under the (possibly new) primary host. Keep existing password if blank.
      const ownerId = agent.ownerId || '';
      const oldCred = await this.prisma.vmCredential.findUnique({ where: { userId_host_protocol: { userId: ownerId, host: agent.hostname ?? '', protocol: 'ssh' } } });
      const username = (body?.username && String(body.username).trim()) || oldCred?.username || '';
      let password = body?.password ? String(body.password) : '';
      if (!password && oldCred) { try { password = decryptJson<string>(oldCred.password); } catch { password = ''; } }
      if (username && password) {
        await this.prisma.vmCredential.upsert({
          where: { userId_host_protocol: { userId: ownerId, host: finalHost, protocol: 'ssh' } },
          update: { username, password: encryptJson(password) },
          create: { userId: ownerId, host: finalHost, protocol: 'ssh', username, password: encryptJson(password) },
        });
      }
    }
    await this.prisma.agent.update({ where: { id }, data });
    return { ok: true };
  }

  /** Admin: remove an agent record (it self-exits on next report since it's gone/inactive). */
  async remove(id: string) {
    await this.prisma.agent.update({ where: { id }, data: { active: false } }).catch(() => undefined);
    await this.prisma.agent.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }

  async list() {
    const agents = await this.prisma.agent.findMany({ orderBy: { lastSeenAt: 'desc' } });
    const now = Date.now();
    const offlineMs = pInt(await sysParams(this.prisma), 'agentOfflineSec', null, 300) * 1000;
    // The agent's group lives on the mirrored IP/Host Monitor (keyed by target == host). Map it back so
    // Guest Agents shares the same group/scope filter as Network Devices and IP/Host Monitor.
    const monitors = await this.prisma.monitor.findMany({ select: { target: true, group: true } });
    const groupByTarget = new Map(monitors.map((m) => [m.target, m.group || 'default']));
    const groupFor = (a: { hostname: string | null; ips: string | null }): string => {
      if (a.hostname && groupByTarget.has(a.hostname)) return groupByTarget.get(a.hostname)!;
      for (const ip of (a.ips ? a.ips.split(',') : [])) if (groupByTarget.has(ip)) return groupByTarget.get(ip)!;
      return 'default';
    };
    return agents.map((a) => ({
      id: a.id,
      name: a.displayName || a.name,
      hostname: a.hostname,
      displayName: a.displayName ?? null,
      machineName: a.name,
      group: groupFor(a),
      version: a.version ?? null,
      currentVersion: AGENT_VERSION,
      outdated: !!a.version && a.version !== AGENT_VERSION,
      os: a.os,
      ips: a.ips ? a.ips.split(',') : [],
      resourceId: a.resourceId,
      cpuPct: a.cpuPct,
      memPct: a.memPct,
      diskPct: a.diskPct,
      netMbps: a.netMbps,
      diskIoKbps: a.diskIoKbps,
      services: a.services,
      active: a.active,
      mode: a.mode,
      outbound: (a as any).outbound ?? false,
      intervalSec: a.intervalSec,
      lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
      online: !!a.lastSeenAt && now - a.lastSeenAt.getTime() < offlineMs,
    }));
  }

  /** OS-inventory drill-down: EVERY VM grouped by OS family -> version with up/down + per-host detail.
   *  Base = all discovered compute resources (cloud + on-prem); hosts running a guest agent are
   *  enriched with live ports/connections/installed-apps. Standalone agents are added too. */
  async osInventory() {
    const [agents, resources] = await Promise.all([
      this.prisma.agent.findMany({ orderBy: { lastSeenAt: 'desc' } }),
      this.prisma.resource.findMany({ where: { type: 'compute' as any } }),
    ]);
    const now = Date.now();
    const offlineMs = pInt(await sysParams(this.prisma), 'agentOfflineSec', null, 300) * 1000;

    // Universal OS classifier — family for every common OS.
    const fam = (os: string): { family: string; label: string } => {
      const o = (os || '').toLowerCase();
      if (/windows|microsoft|win32|winnt/.test(o)) return { family: 'windows', label: 'Windows' };
      if (/mac\s?os|darwin|os\s?x/.test(o)) return { family: 'macos', label: 'macOS' };
      if (/free\s?bsd|open\s?bsd|net\s?bsd/.test(o)) return { family: 'bsd', label: 'BSD' };
      if (/ubuntu|debian|mint|red\s?hat|rhel|centos|fedora|rocky|alma|oracle|suse|sles|sled|opensuse|amazon|arch|gentoo|kali|alpine|linux|unix/.test(o)) return { family: 'linux', label: 'Linux' };
      if (!o) return { family: 'unknown', label: 'Unidentified' };
      return { family: 'other', label: 'Other' };
    };
    // Normalize any OS string to a clean version label, e.g. "Microsoft Windows Server 2022 Standard"
    // -> "Server 2022"; "Windows 11 Enterprise" -> "Windows 11"; "Ubuntu 22.04.3 LTS" -> "Ubuntu 22.04".
    const versionLabel = (family: string, raw: string): string => {
      const s = (raw || '').trim();
      if (family === 'windows') {
        const sv = s.match(/server\s*(20\d\d)(\s*r2)?/i);
        if (sv) return `Server ${sv[1]}${sv[2] ? ' R2' : ''}`;
        const cl = s.match(/windows\s*(11|10|8\.1|8|7|vista|xp)\b/i);
        if (cl) return `Windows ${cl[1].toLowerCase() === 'xp' ? 'XP' : cl[1]}`;
        return /server/i.test(s) ? 'Server (version n/a)' : 'Windows (version n/a)';
      }
      if (family === 'linux') {
        const distros: [RegExp, string][] = [
          [/ubuntu/i, 'Ubuntu'], [/linux mint|\bmint\b/i, 'Linux Mint'], [/debian/i, 'Debian'],
          [/red\s?hat|\brhel\b/i, 'RHEL'], [/centos/i, 'CentOS'], [/rocky/i, 'Rocky Linux'],
          [/alma/i, 'AlmaLinux'], [/oracle/i, 'Oracle Linux'], [/amazon/i, 'Amazon Linux'],
          [/opensuse/i, 'openSUSE'], [/sles|sled|suse/i, 'SUSE'], [/fedora/i, 'Fedora'],
          [/alpine/i, 'Alpine'], [/arch/i, 'Arch'], [/gentoo/i, 'Gentoo'], [/kali/i, 'Kali'],
        ];
        for (const [re, name] of distros) if (re.test(s)) {
          const v = /ubuntu/i.test(s) ? (s.match(/(\d+\.\d+)/) ?? [])[1] : (s.match(/(\d+(?:\.\d+)?)/) ?? [])[1];
          return `${name}${v ? ' ' + v : ''}`;
        }
        const v = (s.match(/(\d+(?:\.\d+)?)/) ?? [])[1];
        return v ? `Linux ${v}` : 'Linux (distro n/a)';
      }
      if (family === 'macos') { const v = (s.match(/(\d+(?:\.\d+)?)/) ?? [])[1]; return v ? `macOS ${v}` : 'macOS'; }
      return s ? s.slice(0, 40) : 'Unknown';
    };
    // Coarse end-of-life flag for the inventory risk view (conservative — only clearly-dead versions).
    const support = (family: string, label: string): 'eol' | 'ok' | 'unknown' => {
      const s = (label || '').toLowerCase();
      if (/n\/a|unknown/.test(s)) return 'unknown';
      if (family === 'windows') {
        if (/\b(xp|vista)\b|windows (7|8|8\.1)\b/.test(s)) return 'eol';
        if (/server (2003|2008|2012)/.test(s)) return 'eol';
        return 'ok';
      }
      if (family === 'linux') {
        if (/centos/.test(s)) return 'eol';
        const m = s.match(/(\d+)(?:\.(\d+))?/);
        if (m && /ubuntu/.test(s) && Number(m[1]) < 20) return 'eol';
        if (m && /(rhel|rocky|alma|oracle)/.test(s) && Number(m[1]) < 7) return 'eol';
        if (m && /debian/.test(s) && Number(m[1]) < 10) return 'eol';
        return 'ok';
      }
      return 'unknown';
    };
    const toApps = (a: any): string[] => {
      const inst = Array.isArray(a.installedApps) ? a.installedApps : [];
      if (inst.length) return inst.map((x: any) => (typeof x === 'string' ? x : `${x.name}${x.version ? ' ' + x.version : ''}`)).filter(Boolean).slice(0, 200);
      const svc = Array.isArray(a.services) ? a.services : [];
      return svc.map((x: any) => (typeof x === 'string' ? x : x?.name)).filter(Boolean).slice(0, 200);
    };
    const toPorts = (a: any) => (Array.isArray(a.openPorts) ? a.openPorts : [])
      .map((x: any) => (typeof x === 'number' ? { port: x } : { port: x?.port, proc: x?.proc }))
      .filter((x: any) => x.port).slice(0, 200);
    const toConns = (a: any) => (Array.isArray(a.connections) ? a.connections : [])
      .filter((x: any) => x && (x.raddr || x.rport)).slice(0, 300);

    const agentUp = (a: any) => !!a.lastSeenAt && now - a.lastSeenAt.getTime() < offlineMs;
    const agentByResource = new Map<string, any>();
    for (const a of agents) if (a.resourceId) agentByResource.set(a.resourceId, a);
    const usedAgents = new Set<string>();

    // A unified host = a VM, optionally enriched by its guest agent.
    const buildHost = (opts: { id: string; name: string; provider?: string | null; status?: string; rawOs: string; ips: string[]; up: boolean; agent?: any }) => {
      const a = opts.agent;
      return {
        id: opts.id,
        name: opts.name,
        provider: opts.provider ?? null,
        status: opts.status ?? (opts.up ? 'running' : 'unknown'),
        hasAgent: !!a,
        ips: opts.ips,
        up: opts.up,
        rawOs: opts.rawOs,
        lastSeenAt: a?.lastSeenAt?.toISOString() ?? null,
        osVersion: opts.rawOs || null,
        appsSource: a && Array.isArray(a.installedApps) && a.installedApps.length ? 'installed' : 'running',
        apps: a ? toApps(a) : [],
        ports: a ? toPorts(a) : [],
        connections: a ? toConns(a) : [],
      };
    };

    const hosts: any[] = [];
    // 1) Every discovered compute VM — enriched by its agent when one is linked.
    for (const r of resources) {
      const a = agentByResource.get(r.id);
      if (a) usedAgents.add(a.id);
      const props = (r.properties && typeof r.properties === 'object' ? r.properties : {}) as any;
      const rawOs = (a ? (a.osVersion || a.os) : (props.osVersion || props.os || props.osType || props.platform || props.guestOS)) || '';
      const ip = props.privateIp || props.ip || props.publicIp || props.ipAddress || props.privateIpAddress || '';
      const ips = a && a.ips ? a.ips.split(',').filter(Boolean) : (ip ? [String(ip)] : []);
      const up = a ? agentUp(a) : r.status === 'running';
      hosts.push(buildHost({ id: r.id, name: r.name, provider: r.provider, status: r.status, rawOs, ips, up, agent: a }));
    }
    // 2) Agents with no matching resource (standalone hosts) — don't drop them.
    for (const a of agents) {
      if (usedAgents.has(a.id)) continue;
      const rawOs = (a as any).osVersion || a.os || '';
      hosts.push(buildHost({ id: a.id, name: a.displayName || a.name, status: agentUp(a) ? 'running' : 'offline', rawOs, ips: a.ips ? a.ips.split(',').filter(Boolean) : [], up: agentUp(a), agent: a }));
    }

    const families = new Map<string, any>();
    for (const h of hosts) {
      const f = fam(h.rawOs);
      const ver = versionLabel(f.family, h.rawOs);
      delete h.rawOs;
      if (!families.has(f.family)) families.set(f.family, { family: f.family, label: f.label, total: 0, up: 0, down: 0, withAgent: 0, _v: new Map() });
      const fe = families.get(f.family);
      fe.total++; h.up ? fe.up++ : fe.down++; if (h.hasAgent) fe.withAgent++;
      if (!fe._v.has(ver)) fe._v.set(ver, { version: ver, support: support(f.family, ver), total: 0, up: 0, down: 0, hosts: [] });
      const ve = fe._v.get(ver);
      ve.total++; h.up ? ve.up++ : ve.down++;
      ve.hosts.push(h);
    }
    const out = [...families.values()]
      .map((fe) => ({ family: fe.family, label: fe.label, total: fe.total, up: fe.up, down: fe.down, withAgent: fe.withAgent, versions: [...fe._v.values()].sort((x, y) => y.total - x.total) }))
      .sort((x, y) => y.total - x.total);
    return { families: out, totalHosts: hosts.length, withAgent: agents.length, updatedAt: new Date().toISOString() };
  }

  /**
   * Env-aware base URL: prefer the host the request arrived on (behind nginx, `Host` is the external
   * host the user hit) so an agent downloaded from production targets production, not the dev default.
   */
  baseUrl(host?: string): string {
    // Explicit override wins — set AGENT_ENDPOINT_URL when MCMF's HTTPS is on a non-443 port (e.g.
    // 443 is taken by another web service) or behind a dedicated agent gateway: e.g. https://mcmf.co:8443
    const override = (process.env.AGENT_ENDPOINT_URL || '').trim();
    if (override) return override.replace(/\/$/, '');
    // Otherwise bind to the host:port the request arrived on (Host header behind nginx) — PRESERVING
    // the port, so a download from https://host:8443 makes the agent dial host:8443, not :443.
    const h = String(host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (h && /^[A-Za-z0-9.\-]+(:\d+)?$/.test(h) && !/^(localhost|127\.|::1)/.test(h)) return `https://${h}`;
    return (process.env.SSO_BASE_URL || 'https://localhost').replace(/\/$/, '');
  }

  /** Pre-filled install scripts + service setup + port requirements (key baked in). */
  install(host?: string) {
    const base = this.baseUrl(host);
    const url = `${base}/api/agent/ingest`;
    const key = agentKey();
    return {
      ingestUrl: url,
      key,
      // PURE-OUTBOUND agent (recommended): dials home over HTTPS, no inbound port. Telemetry + a
      // long-poll command channel (run/power/config/self-update) over one outbound connection.
      linuxOutboundAgent: linuxOutboundAgent(base, key, 60),
      linuxInstallCommand: `curl -fsSk '${base}/api/agent/linux-install?k=${encodeURIComponent(key)}' | sudo bash`,
      // THE single MCMF agent (raw-TCP pull). MCMF connects IN on a custom port and pulls metrics,
      // top processes, uptime, IPs and events (SIEM/SOC). One per OS — no other agent variants.
      linuxTcpAgent: linuxTcpAgent(9182, key),
      windowsExeAgent: windowsExeAgent(key),
      // Windows system-tray endpoint app (PUSH + PULL): configurable MCMF IP/port, admin-gated,
      // selectable telemetry, posture + logged-in user for the future AAA / NAC (ClearPass-style).
      // Delivered as a built .exe installer via GET /agent/windows-installer (this is the raw source).
      // Bake the host WITH its port (MCMF may run off 443), so the agent dials the right endpoint.
      windowsTrayAgent: trayAgent(key, base.replace(/^https?:\/\//, ''), 9182),
      // Run-once "enable SSH" prep for the agentless SSH-pull option (no install at all).
      linuxPrep: LINUX_PREP,
      windowsPrep: WINDOWS_PREP,
      // Install THE agent as a service (systemd / scheduled task) — survives reboot.
      linuxService: LINUX_SERVICE,
      windowsService: WINDOWS_SERVICE,
      ports: [
        // ── Recommended: pure-outbound agent — the VM opens NOTHING inbound ──
        { dir: 'outbound', from: 'VM (agent)', to: 'MCMF server', proto: 'HTTPS', port: `${(base.match(/:(\d+)/)?.[1]) || '443'}`, why: 'The ONLY rule the outbound agent needs. The agent dials home over HTTPS (the MCMF port — 443 or your custom port) for telemetry + the command channel + the console tunnel. No inbound port, no firewall rule on the VM. Works behind NAT.' },
        // ── Legacy pull model (alternative — only if you use the inbound-pull agent) ──
        { dir: 'inbound', from: 'MCMF server', to: 'VM', proto: 'TCP', port: '9182', why: 'LEGACY pull agent only: MCMF connects IN and pulls. NOT needed for the outbound agent.' },
        { dir: 'inbound', from: 'MCMF server (public IP)', to: 'VM', proto: 'TCP', port: '22', why: 'Agentless SSH-pull alternative (no install). NOT needed for the outbound agent.' },
        { dir: 'inbound', from: 'MCMF server', to: 'VM', proto: 'TCP', port: '3389 / 22 / 23', why: 'Browser console for hosts WITHOUT the outbound agent. Agent-managed hosts console over the outbound tunnel — no inbound port.' },
      ],
    };
  }

  /**
   * Build the Windows endpoint-agent INSTALLER (.exe) on the server using NSIS (makensis runs on
   * Linux and emits a native Windows installer). The agent source is token-substituted with this
   * deployment's key + IP + port, then compiled. Cached for the container lifetime.
   */
  private installerCache = new Map<string, Buffer>();
  async windowsInstaller(host?: string): Promise<Buffer> {
    const base = this.baseUrl(host);
    const mcmfIp = base.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    const cached = this.installerCache.get(mcmfIp);
    if (cached) return cached;
    const key = agentKey();
    const mcmfHost = base.replace(/^https?:\/\//, ''); // host:port for the agent's report URL
    const agentPs1 = trayAgent(key, mcmfHost, 9182);
    const nsi = readAsset('mcmf-agent-installer.nsi');
    if (agentPs1.includes('asset not found') || !nsi) throw new BadRequestException('agent assets missing on the server — re-deploy the API image');

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcmf-installer-'));
    try {
      await fs.promises.writeFile(path.join(dir, 'mcmf-tray-agent.ps1'), agentPs1, 'utf8');
      await fs.promises.writeFile(path.join(dir, 'installer.nsi'), nsi, 'utf8');
      try {
        await execFileP('makensis', ['-V2', 'installer.nsi'], { cwd: dir, timeout: 60_000 });
      } catch (e) {
        throw new BadRequestException(`installer build failed (is makensis installed?): ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      }
      const exe = await fs.promises.readFile(path.join(dir, 'MCMF-Agent-Setup.exe'));
      this.installerCache.set(mcmfIp, exe);
      return exe;
    } finally {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The .exe wrapped in a .zip — browsers flag unsigned .exe downloads as unsafe; a .zip sidesteps that. */
  async windowsInstallerZip(host?: string): Promise<Buffer> {
    const exe = await this.windowsInstaller(host);
    return zipSingleFile('MCMF-Agent-Setup.exe', exe);
  }

  private mcmfIp(): string {
    const base = (process.env.SSO_BASE_URL || 'https://localhost').replace(/\/$/, '');
    return base.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  }

  /** Self-contained Windows bootstrap script (zero dependencies) — admin runs it once on the host. */
  windowsBootstrap(host?: string): string {
    const mcmfHost = this.baseUrl(host).replace(/^https?:\/\//, ''); // keep the port (MCMF may run off 443)
    return windowsBootstrapScript(agentKey(), mcmfHost, 9182);
  }

  /** The copy-paste one-liner an admin pastes in an elevated PowerShell on a fresh box. */
  windowsBootstrapOneLiner(host?: string): { url: string; command: string } {
    const base = this.baseUrl(host);
    const url = `${base}/api/agent/bootstrap?k=${encodeURIComponent(agentKey())}`;
    // Use `1 -eq 1` (a $-free True) for the cert-trust callback so the command survives being pasted
    // into an *existing* PowerShell session — an outer PowerShell would otherwise expand `$true` to
    // `True` before the inner `powershell -Command` runs, breaking the cert bypass + the TLS handshake.
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::ServerCertificateValidationCallback={1 -eq 1};[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;iex ((New-Object Net.WebClient).DownloadString('${url}'))"`;
    return { url, command };
  }

  // ── Pure-outbound Linux agent (no inbound port) ───────────────────────────
  /** The Linux agent program (python3), bound to the host it was downloaded from. */
  linuxAgent(host?: string): string {
    return linuxOutboundAgent(this.baseUrl(host), agentKey(), 60);
  }
  /** The one-shot Linux installer script (downloads the agent + installs the systemd service). */
  linuxInstallScript(host?: string): string {
    return linuxInstallScript(this.baseUrl(host), agentKey());
  }
  /** The copy-paste Linux install one-liner for the UI (admin). */
  linuxInstallOneLiner(host?: string): { url: string; command: string } {
    const base = this.baseUrl(host);
    const url = `${base}/api/agent/linux-install?k=${encodeURIComponent(agentKey())}`;
    // POSIX sh (works even where bash isn't installed). wget fallback for hosts without curl.
    return { url, command: `curl -fsSk '${url}' | sudo sh` };
  }

  /** A wget-based variant of the one-liner for hosts that lack curl. */
  linuxInstallOneLinerWget(host?: string): string {
    const url = this.linuxInstallOneLiner(host).url;
    return `wget --no-check-certificate -qO- '${url}' | sudo sh`;
  }

  // ── Outbound command channel (pure HTTPS, no inbound ports) ───────────────
  /** Admin: queue a command for an outbound agent (run | power | config | update). */
  async enqueueCommand(userId: string, agentId: string, body: { kind?: string; payload?: any }) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('agent not found');
    const kind = String(body?.kind ?? '').trim();
    if (!['run', 'power', 'config', 'update', 'uninstall'].includes(kind)) throw new BadRequestException('kind must be run | power | config | update | uninstall');
    if (kind === 'run' && !String(body?.payload?.command ?? '').trim()) throw new BadRequestException('run requires payload.command');
    if (kind === 'power' && !['restart', 'shutdown'].includes(String(body?.payload?.action ?? ''))) throw new BadRequestException('power requires payload.action = restart | shutdown');
    const cmd = await this.prisma.agentCommand.create({ data: { agentId, kind, payload: (body?.payload ?? {}) as any, createdById: userId ?? '' } });
    return { ok: true, commandId: cmd.id, status: cmd.status };
  }

  /**
   * Shut down + remove an agent: queue an 'uninstall' command (the agent removes its own service +
   * files and exits) and mark it decommissioned so it stops even if it can't fully self-remove. The
   * agent row is deleted automatically when the uninstall result comes back (or via Remove).
   */
  async shutdownAgent(userId: string, agentId: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('agent not found');
    await this.prisma.agentCommand.create({ data: { agentId, kind: 'uninstall', payload: {} as any, createdById: userId ?? '' } });
    await this.prisma.agent.update({ where: { id: agentId }, data: { active: false } }).catch(() => undefined);
    return { ok: true, message: `Shutdown sent to ${agent.name}. It will uninstall itself (remove its service + files) on its next check-in, then disappear from the list.` };
  }

  /**
   * Agent long-poll: holds up to ~25s for queued commands, then returns them (marked delivered).
   * This is the agent's single outbound HTTPS channel — the server never connects in. Authenticated
   * by the agent key. Also marks the agent as an outbound/tunnel agent and records liveness.
   */
  async longPollCommands(agentId: string, key: string, host?: string) {
    await this.assertKeyOrToken(key);
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('agent not found');
    const homeUrl = this.baseUrl(host);
    await this.prisma.agent.update({ where: { id: agentId }, data: { outbound: true, lastPollAt: new Date(), ...(agent.homeUrl ? {} : { homeUrl }) } }).catch(() => undefined);
    const deadline = Date.now() + 25_000;
    const deliver = async () => {
      const queued = await this.prisma.agentCommand.findMany({ where: { agentId, status: 'queued' }, orderBy: { createdAt: 'asc' }, take: 20 });
      if (!queued.length) return null;
      await this.prisma.agentCommand.updateMany({ where: { id: { in: queued.map((c) => c.id) } }, data: { status: 'delivered', deliveredAt: new Date() } });
      return queued.map((c) => ({ id: c.id, kind: c.kind, payload: c.payload }));
    };
    // If decommissioned, still deliver any pending command (e.g. a queued 'uninstall') first, then exit.
    if (!agent.active) {
      const cmds = await deliver();
      return cmds ? { active: true, commands: cmds } : { active: false, commands: [] as any[] };
    }
    for (;;) {
      const cmds = await deliver();
      if (cmds) return { active: true, commands: cmds };
      if (Date.now() >= deadline) return { active: true, commands: [] as any[] };
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Agent posts a command result back over the same outbound channel. */
  async commandResult(key: string, body: { commandId?: string; status?: string; result?: string; exitCode?: number }) {
    await this.assertKeyOrToken(key);
    const id = String(body?.commandId ?? '');
    const cmd = await this.prisma.agentCommand.findUnique({ where: { id } }).catch(() => null);
    if (!cmd) throw new NotFoundException('command not found');
    const status = body?.status === 'failed' ? 'failed' : 'done';
    await this.prisma.agentCommand.update({
      where: { id },
      data: { status, result: String(body?.result ?? '').slice(0, 8000), exitCode: typeof body?.exitCode === 'number' ? body.exitCode : null, doneAt: new Date() },
    });
    // The agent confirmed it uninstalled itself → drop it from the fleet.
    if (cmd.kind === 'uninstall') {
      await this.prisma.agent.delete({ where: { id: cmd.agentId } }).catch(() => undefined);
    }
    return { ok: true };
  }

  /** Admin: recent command history for an agent (for the UI). */
  async listCommands(agentId: string) {
    const rows = await this.prisma.agentCommand.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((c) => ({ id: c.id, kind: c.kind, payload: c.payload, status: c.status, result: c.result, exitCode: c.exitCode, createdAt: c.createdAt.toISOString(), doneAt: c.doneAt?.toISOString() ?? null }));
  }
}

// ── SSH-pull prep (recommended for private MCMF) ────────────────────────────
// The VM can't reach MCMF; MCMF reaches the VM's PUBLIC IP and pulls over SSH.
// These run-once scripts just make the VM reachable on SSH — no push agent, no
// outbound connection to MCMF. After running, enroll the VM in MCMF (SSH pull).

const LINUX_PREP = `#!/usr/bin/env bash
# MCMF SSH-pull setup (run with sudo). MCMF connects OUT to this VM and pulls telemetry —
# nothing needs to reach MCMF. Dependency: openssh-server.
# CUSTOM PORT (security): export MCMF_SSH_PORT=2222 before running to use a non-standard SSH port.
set -e
PORT="\${MCMF_SSH_PORT:-22}"
if [ ! -x /usr/sbin/sshd ] && ! command -v sshd >/dev/null 2>&1; then
  if command -v apt-get >/dev/null; then sudo apt-get update && sudo apt-get install -y openssh-server;
  elif command -v dnf >/dev/null; then sudo dnf install -y openssh-server;
  elif command -v yum >/dev/null; then sudo yum install -y openssh-server; fi
fi
if [ "$PORT" != "22" ]; then
  sudo sed -i "s/^#\\?Port .*/Port $PORT/" /etc/ssh/sshd_config
  command -v semanage >/dev/null 2>&1 && sudo semanage port -a -t ssh_port_t -p tcp "$PORT" 2>/dev/null || true
fi
sudo systemctl enable --now ssh 2>/dev/null || sudo systemctl enable --now sshd
sudo systemctl restart ssh 2>/dev/null || sudo systemctl restart sshd 2>/dev/null || true
# Open inbound TCP \$PORT in the OS firewall (restrict to the MCMF server IP where you can):
sudo ufw allow "\${PORT}/tcp" 2>/dev/null || { sudo firewall-cmd --permanent --add-port="\${PORT}/tcp" && sudo firewall-cmd --reload; } 2>/dev/null || true
echo "OK: sshd listening on port \$PORT. Now in MCMF -> Command Center -> + Add SSH pull target:"
echo "   Host = this VM's IP, Port = \$PORT, OS = Linux, with a login user."
echo "Also allow inbound TCP \$PORT from the MCMF server on your cloud NSG / security group."`;

const WINDOWS_PREP = `# MCMF SSH-pull setup (run as Administrator). MCMF connects OUT to this VM and pulls telemetry
# over SSH — nothing needs to reach MCMF. Dependency: OpenSSH Server (built into Windows 10/11 & Server 2019+).
# CUSTOM PORT (security): set $env:MCMF_SSH_PORT='2222' before running to use a non-standard SSH port.
$Port = if ($env:MCMF_SSH_PORT) { [int]$env:MCMF_SSH_PORT } else { 22 }
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
# Make PowerShell the SSH default shell so MCMF's collector runs correctly:
New-Item -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -PropertyType String -Force | Out-Null
if ($Port -ne 22) {
  $cfg = 'C:\\ProgramData\\ssh\\sshd_config'
  if (Test-Path $cfg) { (Get-Content $cfg) -replace '^#?Port .*', "Port $Port" | Set-Content $cfg; Restart-Service sshd }
}
# Open inbound TCP $Port in Windows Firewall (replace 'Any' with the MCMF server IP to restrict):
New-NetFirewallRule -DisplayName "MCMF SSH pull $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -RemoteAddress Any -ErrorAction SilentlyContinue | Out-Null
Write-Host "OK: OpenSSH Server listening on port $Port. Now in MCMF -> Command Center -> + Add SSH pull target:"
Write-Host "   Host = this VM IP, Port = $Port, OS = Windows, with a local admin user + password."
Write-Host "Also allow inbound TCP $Port from the MCMF server on your cloud NSG / security group."`;

/** Windows TCP telemetry agent — MCMF pulls from it over a raw TCP socket on a custom port (key auth). Compilable to .exe via PS2EXE. */
/**
 * The Windows system-tray endpoint app (PowerShell + WinForms). Kept as a .ps1 asset (its backticks
 * and backslashes don't survive a TS template literal); we read it and bake in the key/IP/port.
 */
/** Locate an agent-asset file across the candidate paths used in the container/dev. */
// Minimal, dependency-free ZIP (single deflated entry) so the unsigned .exe can be offered as a .zip
// download (browsers block/flag unsigned .exe downloads; a .zip avoids the "not safe" warning).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipSingleFile(filename: string, data: Buffer): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('node:zlib');
  const comp: Buffer = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const name = Buffer.from(filename, 'utf8');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6); lfh.writeUInt16LE(8, 8);
  lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0x21, 12); lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(data.length, 22); lfh.writeUInt16LE(name.length, 26); lfh.writeUInt16LE(0, 28);
  const body = Buffer.concat([lfh, name, comp]);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(8, 10);
  cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0x21, 14); cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(comp.length, 20); cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(name.length, 28); cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32); cdh.writeUInt16LE(0, 34); cdh.writeUInt16LE(0, 36);
  cdh.writeUInt32LE(0, 38); cdh.writeUInt32LE(0, 42);
  const cd = Buffer.concat([cdh, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(body.length, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([body, cd, eocd]);
}

function readAsset(name: string): string {
  const candidates = [
    path.join(process.cwd(), 'src/agent-assets', name),
    path.join(__dirname, '../../agent-assets', name),
    path.join(__dirname, '../../../src/agent-assets', name),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* try next */ }
  }
  return '';
}

function trayAgent(key: string, mcmfIp: string, port: number): string {
  const raw = readAsset('mcmf-tray-agent.ps1');
  if (!raw) return '# MCMF tray agent asset not found on the server. Re-deploy the API image.';
  return raw
    .split('__MCMF_KEY__').join(key)
    .split('__MCMF_IP__').join(mcmfIp)
    .split('__MCMF_PORT__').join(String(port))
    .split('__AGENT_VERSION__').join(AGENT_VERSION);
}

/** Pure-outbound Linux agent (python3, no inbound port), with URL+key+interval baked in. */
function linuxOutboundAgent(baseUrl: string, key: string, intervalSec: number): string {
  const raw = readAsset('mcmf-agent-linux.py');
  if (!raw) return '# MCMF linux agent asset not found on the server. Re-deploy the API image.';
  return raw
    .split('__MCMF_URL__').join(baseUrl.replace(/\/$/, ''))
    .split('__MCMF_KEY__').join(key)
    .split('__MCMF_INTERVAL__').join(String(intervalSec))
    .split('__AGENT_VERSION__').join(AGENT_VERSION);
}

/**
 * One-shot UNIVERSAL Linux installer — runs on any distro (Ubuntu/Debian, SUSE, RHEL/CentOS/Fedora,
 * Alpine, Arch, …). POSIX sh (no bashisms). Installs python3 if missing, downloads the pure-outbound
 * agent, and registers it as a service: systemd → OpenRC → SysV init + cron @reboot fallback.
 */
function linuxInstallScript(baseUrl: string, key: string): string {
  const base = baseUrl.replace(/\/$/, '');
  const k = encodeURIComponent(key);
  return `#!/bin/sh
# MCMF Linux Endpoint Agent installer — pure outbound (no inbound port). Run as root / with sudo.
set -e
BASE="${base}"
KEY="${k}"
DIR=/opt/mcmf-agent

if [ "$(id -u)" != "0" ]; then echo "Please run as root:  curl -fsSk \\"$BASE/api/agent/linux-install?k=$KEY\\" | sudo sh"; exit 1; fi

# 1) ensure python3 (any package manager)
if ! command -v python3 >/dev/null 2>&1; then
  echo "Installing python3 ..."
  if   command -v apt-get >/dev/null 2>&1; then apt-get update -y >/dev/null 2>&1 || true; apt-get install -y python3 || true
  elif command -v dnf     >/dev/null 2>&1; then dnf install -y python3 || true
  elif command -v yum     >/dev/null 2>&1; then yum install -y python3 || true
  elif command -v zypper  >/dev/null 2>&1; then zypper --non-interactive install python3 || true
  elif command -v apk     >/dev/null 2>&1; then apk add --no-cache python3 || true
  elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm python || true
  fi
fi
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "ERROR: python3 not found and could not be installed automatically — install python3 and re-run."; exit 1; }

# 2) download the agent (curl or wget)
mkdir -p "$DIR"
echo "Downloading the MCMF agent from $BASE ..."
if   command -v curl >/dev/null 2>&1; then curl -fsSk "$BASE/api/agent/linux?k=$KEY" -o "$DIR/agent.py"
elif command -v wget >/dev/null 2>&1; then wget --no-check-certificate -qO "$DIR/agent.py" "$BASE/api/agent/linux?k=$KEY"
else echo "ERROR: need curl or wget."; exit 1; fi
chmod +x "$DIR/agent.py"

# 3) register as a service — systemd, else OpenRC, else SysV init + cron @reboot
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/mcmf-agent.service <<UNIT
[Unit]
Description=MCMF Endpoint Agent (outbound)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$PY $DIR/agent.py
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now mcmf-agent
  echo "Installed as systemd service 'mcmf-agent'. Status: systemctl status mcmf-agent --no-pager"
elif command -v rc-update >/dev/null 2>&1; then
  cat > /etc/init.d/mcmf-agent <<RC
#!/sbin/openrc-run
name="mcmf-agent"
command="$PY"
command_args="$DIR/agent.py"
command_background=true
pidfile="/run/mcmf-agent.pid"
output_log="/var/log/mcmf-agent.log"
error_log="/var/log/mcmf-agent.log"
depend() { need net; }
RC
  chmod +x /etc/init.d/mcmf-agent
  rc-update add mcmf-agent default >/dev/null 2>&1 || true
  rc-service mcmf-agent restart || rc-service mcmf-agent start
  echo "Installed as OpenRC service 'mcmf-agent'."
else
  cat > /etc/init.d/mcmf-agent <<INIT
#!/bin/sh
### BEGIN INIT INFO
# Provides: mcmf-agent
# Required-Start: \\$network
# Required-Stop: \\$network
# Default-Start: 2 3 4 5
# Default-Stop: 0 1 6
# Short-Description: MCMF Endpoint Agent (outbound)
### END INIT INFO
PIDF=/run/mcmf-agent.pid
case "\\$1" in
  start) [ -f "\\$PIDF" ] && kill -0 "\\$(cat \\$PIDF)" 2>/dev/null && exit 0
         nohup $PY $DIR/agent.py >/var/log/mcmf-agent.log 2>&1 & echo \\$! > "\\$PIDF" ;;
  stop)  [ -f "\\$PIDF" ] && kill "\\$(cat \\$PIDF)" 2>/dev/null; rm -f "\\$PIDF" ;;
  restart) "\\$0" stop; sleep 1; "\\$0" start ;;
  *) echo "usage: \\$0 {start|stop|restart}"; exit 1 ;;
esac
INIT
  chmod +x /etc/init.d/mcmf-agent
  command -v update-rc.d >/dev/null 2>&1 && update-rc.d mcmf-agent defaults >/dev/null 2>&1 || true
  command -v chkconfig   >/dev/null 2>&1 && { chkconfig --add mcmf-agent >/dev/null 2>&1; chkconfig mcmf-agent on >/dev/null 2>&1; } || true
  ( crontab -l 2>/dev/null | grep -v mcmf-agent || true; echo "@reboot $PY $DIR/agent.py >/var/log/mcmf-agent.log 2>&1 &" ) | crontab - 2>/dev/null || true
  /etc/init.d/mcmf-agent start
  echo "Installed (SysV init + cron @reboot). Started in the background; log: /var/log/mcmf-agent.log"
fi
echo "Done — the MCMF agent reports to $BASE over HTTPS. No inbound port needed."
`;
}

function windowsExeAgent(key: string): string {
  return `# MCMF Telemetry Agent (raw TCP — no HTTP/HTTPS). MCMF connects IN to this VM on a custom port and pulls.
# Protocol: client sends a line "AUTH <key>"; agent replies with one line of JSON telemetry, then closes.
# Run as Administrator / SYSTEM. Set a custom port with $env:MCMF_AGENT_PORT (default 9182).
$Port = if ($env:MCMF_AGENT_PORT) { [int]$env:MCMF_AGENT_PORT } else { 9182 }
$KEY  = "${key}"
New-NetFirewallRule -DisplayName "MCMF Agent $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -RemoteAddress Any -ErrorAction SilentlyContinue | Out-Null
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
$listener.Start()
Write-Host "MCMF agent listening (TCP) on :$Port"
while ($true) {
  try {
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $writer = New-Object System.IO.StreamWriter($stream); $writer.AutoFlush = $true
    $line = $reader.ReadLine()
    if ($line -ne "AUTH $KEY") { $writer.WriteLine('{"error":"auth"}'); $client.Close(); continue }
    $cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $o=Get-CimInstance Win32_OperatingSystem
    $mem=[math]::Round((1-$o.FreePhysicalMemory/$o.TotalVisibleMemorySize)*100,1)
    $d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    $disk=[math]::Round((1-$d.FreeSpace/$d.Size)*100,1)
    $ips=@((Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -ne '127.0.0.1'}).IPAddress)
    $tp=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; $nc=[Math]::Max(1,(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors); $cm=@{}
    try { (Get-Counter '\\Process(*)\\% Processor Time').CounterSamples | ForEach-Object { if($_.InstanceName -and $_.InstanceName -ne '_total' -and $_.InstanceName -ne 'idle'){ $cm[$_.InstanceName]=[math]::Round($_.CookedValue/$nc,1) } } } catch {}
    $svc=@(Get-Process | Group-Object ProcessName | ForEach-Object { $ws=($_.Group | Measure-Object WorkingSet64 -Sum).Sum; @{name=$_.Name;cpu=[double]$cm[$_.Name.ToLower()];mem=$(if($tp){[math]::Round($ws/$tp*100,1)}else{0});status='running'} } | Sort-Object {$_.cpu},{$_.mem} -Descending | Select-Object -First 20)
    $evt=@(Get-WinEvent -FilterHashtable @{LogName='System';Level=2,3} -MaxEvents 10 -ErrorAction SilentlyContinue | ForEach-Object {@{level='warning';category='system';message=$_.Message.Substring(0,[math]::Min(300,$_.Message.Length))}})
    $body=@{hostname=$env:COMPUTERNAME;os='windows';ips=$ips;cpuPct=$cpu;memPct=$mem;diskPct=$disk;services=$svc;events=$evt} | ConvertTo-Json -Depth 6 -Compress
    $writer.WriteLine($body)
    $client.Close()
  } catch { Start-Sleep -Milliseconds 500 }
}
# ── Run on boot as a SYSTEM scheduled task ──
#   New-Item -ItemType Directory -Force 'C:\\Program Files\\MCMF' | Out-Null
#   Copy-Item mcmf-agent.ps1 'C:\\Program Files\\MCMF\\mcmf-agent.ps1'
#   $a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Program Files\\MCMF\\mcmf-agent.ps1"'
#   Register-ScheduledTask -TaskName 'MCMF Agent' -Action $a -Trigger (New-ScheduledTaskTrigger -AtStartup) -User SYSTEM -RunLevel Highest -Force; Start-ScheduledTask -TaskName 'MCMF Agent'
# ── Compile to a single .exe (optional) ──
#   Install-Module ps2exe -Scope CurrentUser -Force; Invoke-PS2EXE .\\mcmf-agent.ps1 .\\mcmf-agent.exe -noConsole
# Then in MCMF: Command Center -> + Add target -> Method = Agent, host = this VM IP, port = $Port, key = the value above.`;
}

// Linux raw-TCP listener agent (push-installed remotely over SSH). Same wire protocol as the
// Windows .exe agent: client sends "AUTH <key>", agent replies with one JSON telemetry line.
function linuxTcpAgent(port: number, key: string): string {
  return `#!/usr/bin/env python3
# MCMF guest agent (Linux, raw TCP — no HTTP). MCMF connects IN on a custom port and pulls.
import json,socket,time,os,shutil,subprocess
PORT=int(os.environ.get("MCMF_AGENT_PORT","${port}"))
KEY="${key}"
NL=bytes([10])
CLK=os.sysconf("SC_CLK_TCK") if hasattr(os,"sysconf") else 100
NCPU=os.cpu_count() or 1
PAGE=os.sysconf("SC_PAGE_SIZE") if hasattr(os,"sysconf") else 4096
ST={"ts":0.0,"cpu":{},"io":{},"net":None,"disk":None}  # previous samples for rate computation
def sh(c):
    try: return subprocess.run(c,shell=True,capture_output=True,text=True,timeout=6).stdout
    except Exception: return ""
def rd(p):
    try:
        with open(p) as f: return f.read()
    except Exception: return ""
def memtotal():
    for l in open("/proc/meminfo"):
        if l.startswith("MemTotal"): return int(l.split()[1])*1024
    return 1
def cpu():
    def s():
        p=[int(x) for x in open("/proc/stat").readline().split()[1:8]]
        return sum(p),p[3]
    a,ai=s(); time.sleep(1); b,bi=s()
    return round((1-(bi-ai)/max(b-a,1))*100,1)
def mem():
    d={}
    for l in open("/proc/meminfo"):
        q=l.split(":")
        d[q[0]]=int(q[1].split()[0])
    return round((1-d.get("MemAvailable",0)/d.get("MemTotal",1))*100,1)
def disk():
    u=shutil.disk_usage("/"); return round(u.used/u.total*100,1)
def netbytes():
    rx=tx=0
    for l in open("/proc/net/dev").read().splitlines()[2:]:
        parts=l.split(":")
        if len(parts)<2: continue
        if parts[0].strip()=="lo": continue
        f=parts[1].split()
        if len(f)>=9: rx+=int(f[0]); tx+=int(f[8])
    return rx+tx
def diskbytes():
    tot=0
    try:
        for dev in os.listdir("/sys/block"):
            if dev.startswith(("loop","ram")): continue
            f=rd("/sys/block/%s/stat"%dev).split()
            if len(f)>=10: tot+=(int(f[2])+int(f[6]))*512  # (sectors read + written) * 512
    except Exception: pass
    return tot
def procs(dt):
    tm=memtotal(); cc={}; ci={}; rows=[]
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        st=rd("/proc/%s/stat"%pid)
        if not st: continue
        try:
            rp=st.rfind(")"); comm=st[st.find("(")+1:rp]; fl=st[rp+2:].split()
            jiff=int(fl[11])+int(fl[12])
        except Exception: continue
        cc[pid]=jiff
        try: rss=int(rd("/proc/%s/statm"%pid).split()[1])*PAGE
        except Exception: rss=0
        io=0
        for ln in rd("/proc/%s/io"%pid).splitlines():
            if ln.startswith("read_bytes:") or ln.startswith("write_bytes:"):
                try: io+=int(ln.split()[1])
                except Exception: pass
        ci[pid]=io
        pc=0.0; dk=0.0
        if dt>0 and pid in ST["cpu"]:
            dj=jiff-ST["cpu"][pid]
            if dj>0: pc=round(dj/CLK/dt/NCPU*100,1)
        if dt>0 and pid in ST["io"]:
            db=io-ST["io"][pid]
            if db>0: dk=round(db/dt/1024,1)
        rows.append({"name":comm,"cpu":pc,"mem":round(rss/tm*100,1),"diskKbps":dk,"status":"running"})
    ST["cpu"]=cc; ST["io"]=ci
    rows.sort(key=lambda r:(r["cpu"],r["mem"]),reverse=True)
    return rows[:15]
def evts():
    o=sh("journalctl -p warning -n 8 --no-pager -o cat")
    return [{"level":"warning","category":"system","message":l[:300]} for l in o.splitlines() if l.strip()]
def ips():
    return [x for x in sh("hostname -I").split() if x]
def snap():
    now=time.time(); dt=now-ST["ts"] if ST["ts"] else 0
    nb=netbytes(); netMbps=0.0
    if dt>0 and ST["net"] is not None: netMbps=round(max(0,nb-ST["net"])*8/dt/1e6,2)
    dbk=diskbytes(); diskIoKbps=0.0
    if dt>0 and ST["disk"] is not None: diskIoKbps=round(max(0,dbk-ST["disk"])/dt/1024,1)
    pr=procs(dt)
    ST["ts"]=now; ST["net"]=nb; ST["disk"]=dbk
    return json.dumps({"hostname":socket.gethostname(),"os":"linux","ips":ips(),"cpuPct":cpu(),"memPct":mem(),"diskPct":disk(),"netMbps":netMbps,"diskIoKbps":diskIoKbps,"services":pr,"events":evts()})
srv=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
srv.bind(("0.0.0.0",PORT)); srv.listen(5)
while True:
    try:
        c,_=srv.accept(); c.settimeout(8)
        buf=b""
        while NL not in buf and len(buf)<256:
            d=c.recv(64)
            if not d: break
            buf+=d
        if buf.decode("utf-8","ignore").strip()=="AUTH "+KEY:
            c.sendall(snap().encode()+NL)
        else:
            c.sendall(b'{"error":"auth"}'+NL)
        c.close()
    except Exception:
        try: c.close()
        except Exception: pass
# ── Manual install / update (run on the VM) ──
#  1. Save this file as mcmf-agent.py. Pick the port MCMF pulls on (default ${port}).
#  2. Quick test:   MCMF_AGENT_PORT=${port} python3 mcmf-agent.py &
#  3. Install as a service (survives reboot):
#       sudo mkdir -p /opt/mcmf && sudo cp mcmf-agent.py /opt/mcmf/mcmf-agent.py
#       sudo tee /etc/systemd/system/mcmf-agent.service >/dev/null <<'UNIT'
#       [Unit]
#       Description=MCMF Guest Agent (TCP)
#       After=network-online.target
#       [Service]
#       ExecStart=/usr/bin/python3 /opt/mcmf/mcmf-agent.py
#       Restart=always
#       User=root
#       Environment=MCMF_AGENT_PORT=${port}
#       [Install]
#       WantedBy=multi-user.target
#       UNIT
#       sudo systemctl daemon-reload && sudo systemctl enable --now mcmf-agent
#  4. Open the OS firewall:   sudo ufw allow ${port}/tcp   (or firewall-cmd --add-port=${port}/tcp --permanent && firewall-cmd --reload)
#  5. Update later: re-copy this file over /opt/mcmf/mcmf-agent.py, then: sudo systemctl restart mcmf-agent
#  Then in MCMF: Command Center → enroll this VM IP with Method = Agent, port = ${port}, key = the value baked in above.
#  (Or just click "⤓ Push agent" in Command Center and MCMF installs all of this for you over SSH.)
`;
}

// Build the over-SSH install command: drop the script, register a systemd service (if passwordless
// sudo is available) or run it detached, and open the OS firewall for the agent port.
function linuxPushInstallCommand(port: number, b64: string): string {
  return `PORT=${port}
command -v python3 >/dev/null 2>&1 || { echo MCMF_ERR=python3_missing; exit 0; }
B64='${b64}'
echo "$B64" | base64 -d > /tmp/mcmf-agent.py
INSTALL=nohup
CRON=no
SUDO=""; sudo -n true 2>/dev/null && SUDO="sudo"
# Free the agent port from any STALE agent BEFORE (re)installing, so a re-push always replaces the
# old process. Kill BY PORT (a socket fact) using whatever tool exists — never match by cmdline,
# which would kill this very install shell. Try ss, then lsof, then fuser (covers all distros).
KP=$($SUDO ss -ltnpH "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -z "$KP" ] && command -v lsof >/dev/null 2>&1 && KP=$($SUDO lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1)
[ -n "$KP" ] && { $SUDO kill "$KP" 2>/dev/null; sleep 1; $SUDO kill -9 "$KP" 2>/dev/null; }
$SUDO fuser -k ${port}/tcp >/dev/null 2>&1 || true
sleep 1
if [ -n "$SUDO" ]; then
  sudo mkdir -p /opt/mcmf && sudo cp /tmp/mcmf-agent.py /opt/mcmf/mcmf-agent.py
  printf '%s\\n' '[Unit]' 'Description=MCMF Guest Agent (TCP)' 'After=network-online.target' '[Service]' 'ExecStart=/usr/bin/python3 /opt/mcmf/mcmf-agent.py' 'Restart=always' 'User=root' 'Environment=MCMF_AGENT_PORT=${port}' '[Install]' 'WantedBy=multi-user.target' | sudo tee /etc/systemd/system/mcmf-agent.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable mcmf-agent >/dev/null 2>&1
  sudo systemctl restart mcmf-agent
  sudo ufw allow ${port}/tcp >/dev/null 2>&1 || { sudo firewall-cmd --add-port=${port}/tcp --permanent >/dev/null 2>&1 && sudo firewall-cmd --reload >/dev/null 2>&1; }
  INSTALL=systemd
else
  # The port was already freed above (robust kill-by-port). Start the new agent.
  # Immediate start (nohup + subshell so it survives the channel close)...
  ( nohup env MCMF_AGENT_PORT=${port} python3 /tmp/mcmf-agent.py >/tmp/mcmf-agent.log 2>&1 & ) </dev/null >/dev/null 2>&1
  # ...plus a per-minute cron watchdog as resilience: cron-launched processes survive logout even
  # on hosts with systemd-logind KillUserProcesses=yes, and it self-heals if the agent ever dies.
  # The liveness probe is a TCP connect to the port (a socket fact) so it never self-matches.
  if command -v crontab >/dev/null 2>&1; then
    ( crontab -l 2>/dev/null | grep -v 'mcmf-agent'; echo "* * * * * bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' 2>/dev/null || MCMF_AGENT_PORT=${port} /usr/bin/env python3 /tmp/mcmf-agent.py >>/tmp/mcmf-agent.log 2>&1" ) | crontab - >/dev/null 2>&1 && CRON=yes
  fi
  # Best-effort OS firewall (only if the login user happens to have passwordless sudo).
  sudo -n ufw allow ${port}/tcp >/dev/null 2>&1 || true
fi
sleep 2
# Definitive listen check via python3 (present by definition here) — independent of ss/netstat.
python3 -c "import socket;s=socket.socket();s.settimeout(2);s.connect(('127.0.0.1',${port}));s.close()" >/dev/null 2>&1 && echo MCMF_LISTEN=yes || echo MCMF_LISTEN=no
echo MCMF_INSTALL=$INSTALL
[ "$CRON" = yes ] && echo MCMF_CRON=yes
echo MCMF_LOG_START; tail -n 5 /tmp/mcmf-agent.log 2>/dev/null; echo MCMF_LOG_END`;
}

const LINUX_SERVICE = `# Run the agent as a root systemd service (survives reboot, shows in: systemctl status mcmf-agent).
sudo mkdir -p /opt/mcmf && sudo cp mcmf-agent.py /opt/mcmf/
sudo tee /etc/systemd/system/mcmf-agent.service >/dev/null <<'EOF'
[Unit]
Description=MCMF Guest Agent
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 /opt/mcmf/mcmf-agent.py
Restart=always
User=root
Environment=MCMF_INTERVAL=60
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now mcmf-agent
# View:  systemctl status mcmf-agent
# STOP requires root:  sudo systemctl disable --now mcmf-agent`;

const WINDOWS_SERVICE = `# Run as Administrator — registers a SYSTEM startup task (shows in Task Scheduler).
New-Item -ItemType Directory -Force 'C:\\Program Files\\MCMF' | Out-Null
Copy-Item mcmf-agent.ps1 'C:\\Program Files\\MCMF\\mcmf-agent.ps1'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Program Files\\MCMF\\mcmf-agent.ps1"'
$t = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName 'MCMF Guest Agent' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest -Force
Start-ScheduledTask -TaskName 'MCMF Guest Agent'
# STOP requires admin:  Unregister-ScheduledTask -TaskName 'MCMF Guest Agent' -Confirm:$false`;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(1)) : null;
}

/** Normalize a host list (array or comma/space string) → unique, non-blank. */
function cleanHosts(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

/** One-shot SSH command exec (ssh2). Used by the agentless pull engine. */
function sshExec(host: string, port: number, username: string, password: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = '';
    const timer = setTimeout(() => { conn.end(); reject(new Error('ssh timeout')); }, 20_000);
    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) { clearTimeout(timer); conn.end(); return reject(err); }
          stream.on('data', (d: Buffer) => (out += d.toString())).on('close', () => { clearTimeout(timer); conn.end(); resolve(out); });
          stream.stderr.on('data', () => undefined);
        });
      })
      .on('error', (err) => { clearTimeout(timer); reject(err); })
      .connect({ host, port: port || 22, username, password, readyTimeout: 15_000 });
  });
}
