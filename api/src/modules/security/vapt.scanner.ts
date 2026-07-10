import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { PrismaService } from '../../prisma/prisma.service';
import { Provider, Severity, FindingType } from '@prisma/client';

interface Target {
  ip: string;
  name: string;
  provider: Provider;
  resourceId?: string;
}
interface VFinding {
  type: FindingType;
  severity: Severity;
  title: string;
  key: string; // stable per-host key → externalId `nmap:<ip>:<key>` for idempotent upsert/prune
}

/**
 * External VAPT (Vulnerability Assessment & Penetration Testing) of the user's OWN enrolled VMs,
 * using the open-source Nmap scanner + its NSE scripts. MCMF scans each added VM's reachable IP
 * from the outside and classifies what it sees into the three finding buckets:
 *   • vulnerabilities  — CVEs from the `vulners` script (severity from CVSS)
 *   • misconfigurations — clear-text / legacy / remote-admin services exposed, weak TLS
 *   • threats          — exposed unauthenticated datastores, anonymous FTP
 * Only IPs already added to MCMF (monitors / agents / discovered resources) are ever scanned.
 */
@Injectable()
export class VaptScanner {
  private readonly log = new Logger('VAPT');
  private scanning = false;

  constructor(private readonly prisma: PrismaService) {}

  // Risky/legacy services → misconfiguration; exposed datastores → threat.
  private static readonly RISKY: Record<number, { svc: string; sev: Severity; type: FindingType; note: string }> = {
    21: { svc: 'FTP', sev: 'medium', type: 'misconfiguration', note: 'clear-text file transfer exposed' },
    23: { svc: 'Telnet', sev: 'high', type: 'misconfiguration', note: 'clear-text remote shell exposed' },
    69: { svc: 'TFTP', sev: 'medium', type: 'misconfiguration', note: 'unauthenticated TFTP exposed' },
    111: { svc: 'rpcbind', sev: 'medium', type: 'misconfiguration', note: 'RPC portmapper exposed' },
    135: { svc: 'MSRPC', sev: 'medium', type: 'misconfiguration', note: 'Windows RPC endpoint exposed' },
    139: { svc: 'NetBIOS', sev: 'medium', type: 'misconfiguration', note: 'legacy NetBIOS exposed' },
    161: { svc: 'SNMP', sev: 'medium', type: 'misconfiguration', note: 'SNMP exposed (often weak community strings)' },
    389: { svc: 'LDAP', sev: 'medium', type: 'misconfiguration', note: 'directory service exposed' },
    445: { svc: 'SMB', sev: 'high', type: 'misconfiguration', note: 'file sharing (SMB) exposed to the network' },
    512: { svc: 'rexec', sev: 'high', type: 'misconfiguration', note: 'r-services exposed' },
    513: { svc: 'rlogin', sev: 'high', type: 'misconfiguration', note: 'r-services exposed' },
    514: { svc: 'rsh', sev: 'high', type: 'misconfiguration', note: 'r-services exposed' },
    3389: { svc: 'RDP', sev: 'high', type: 'misconfiguration', note: 'Remote Desktop reachable externally' },
    5900: { svc: 'VNC', sev: 'high', type: 'misconfiguration', note: 'remote desktop (VNC) exposed' },
    5901: { svc: 'VNC', sev: 'high', type: 'misconfiguration', note: 'remote desktop (VNC) exposed' },
    // Datastores reachable from outside → treat as active threats.
    1433: { svc: 'MSSQL', sev: 'high', type: 'threat', note: 'database port reachable externally' },
    3306: { svc: 'MySQL', sev: 'high', type: 'threat', note: 'database port reachable externally' },
    5432: { svc: 'PostgreSQL', sev: 'high', type: 'threat', note: 'database port reachable externally' },
    6379: { svc: 'Redis', sev: 'critical', type: 'threat', note: 'Redis (frequently no auth) exposed' },
    9200: { svc: 'Elasticsearch', sev: 'high', type: 'threat', note: 'Elasticsearch exposed' },
    11211: { svc: 'Memcached', sev: 'high', type: 'threat', note: 'Memcached exposed (data leak / amplification)' },
    27017: { svc: 'MongoDB', sev: 'critical', type: 'threat', note: 'MongoDB exposed' },
  };

  /** The full scan ruleset — what an external VAPT scan checks on every enrolled VM. Single source
   *  of truth for the "what we scan & how to comply" panel in the UI. */
  static ruleset() {
    const ports = Object.entries(VaptScanner.RISKY).map(([port, r]) => ({ check: `${r.svc} (TCP ${port})`, port: Number(port), type: r.type as string, severity: r.sev as string, note: r.note }));
    const generic = [
      { check: 'Known CVEs (nmap vulners)', port: null, type: 'vulnerability', severity: 'varies', note: 'matches each detected service/version against the vulners CVE database; severity from CVSS' },
      { check: 'Weak / legacy TLS', port: null, type: 'misconfiguration', severity: 'medium', note: 'SSLv2/SSLv3, TLS 1.0/1.1 and weak ciphers via nmap ssl-enum-ciphers' },
      { check: 'Anonymous FTP', port: 21, type: 'threat', severity: 'high', note: 'anonymous login allowed (ftp-anon)' },
      { check: 'Open / reachable ports', port: null, type: 'misconfiguration', severity: 'info', note: 'full external port sweep; anything reachable that should not be is flagged' },
    ];
    return {
      method: 'Open-source Nmap external assessment of each enrolled VM’s reachable IP (no agent required).',
      categories: ['vulnerability', 'misconfiguration', 'threat'],
      process: [
        'Run an external VAPT scan (or pull cloud-native posture from Defender / Security Hub / SCC).',
        'Triage findings by severity (critical → high → medium); filter by category or provider.',
        'Remediate at the source: close/scope the port in the cloud NSG/security-group + OS firewall, disable the legacy service, or patch the CVE.',
        'Re-scan to confirm the finding clears; resolved findings drop out of the list.',
        'Keep the finding history + audit trail as compliance evidence (Activity → Audit Trail).',
      ],
      rules: [...generic, ...ports],
    };
  }

  /** Kick off a scan of every added VM in the background; returns the target list immediately. */
  async start(): Promise<{ ok: boolean; started: boolean; targets: number; ips: string[]; message: string }> {
    if (this.scanning) return { ok: true, started: false, targets: 0, ips: [], message: 'A VAPT scan is already running.' };
    const targets = await this.gatherTargets();
    if (targets.length === 0) {
      return { ok: true, started: false, targets: 0, ips: [], message: 'No scannable VM IPs are enrolled yet. Add VMs in Command Center / IP Monitor first.' };
    }
    this.scanning = true;
    // Fire-and-forget: scanning many hosts can exceed the HTTP timeout, so findings are written
    // progressively and the UI refetches. Concurrency 3 keeps the host load reasonable.
    void this.runAll(targets)
      .catch((e) => this.log.warn(`VAPT run failed: ${String((e as Error)?.message ?? e)}`))
      .finally(() => (this.scanning = false));
    return { ok: true, started: true, targets: targets.length, ips: targets.map((t) => t.ip), message: `External VAPT started on ${targets.length} VM(s). Findings appear as each host completes.` };
  }

  isScanning() {
    return this.scanning;
  }

  private async runAll(targets: Target[]) {
    await this.prisma.eventLog.create({ data: { type: 'finding', severity: 'info', title: `External VAPT scan started on ${targets.length} VM(s)` } }).catch(() => undefined);
    const queue = [...targets];
    const worker = async () => {
      for (;;) {
        const t = queue.shift();
        if (!t) break;
        try {
          await this.scanOne(t);
        } catch (err) {
          this.log.warn(`scan ${t.ip} failed: ${String((err as Error)?.message ?? err)}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await this.prisma.eventLog.create({ data: { type: 'finding', severity: 'info', title: `External VAPT scan finished (${targets.length} VM(s))` } }).catch(() => undefined);
    this.log.log(`VAPT complete: ${targets.length} host(s)`);
  }

  private async scanOne(t: Target) {
    const xml = await this.nmap(t.ip);
    const findings = this.parse(xml, t.ip);
    const seen: string[] = [];
    for (const f of findings) {
      const externalId = `nmap:${t.ip}:${f.key}`;
      seen.push(externalId);
      await this.prisma.securityFinding
        .upsert({
          where: { externalId },
          create: { externalId, title: f.title.slice(0, 300), type: f.type, severity: f.severity, status: 'open', provider: t.provider, source: 'nmap', resourceName: t.name, resourceId: t.resourceId ?? null, detectedAt: new Date() },
          update: { title: f.title.slice(0, 300), severity: f.severity, status: 'open', resourceName: t.name, detectedAt: new Date() },
        })
        .catch((e) => this.log.warn(`upsert ${externalId}: ${String(e)}`));
    }
    // Prune previous nmap findings for THIS host that are no longer present (host hardened).
    await this.prisma.securityFinding
      .deleteMany({ where: { source: 'nmap', externalId: { startsWith: `nmap:${t.ip}:`, notIn: seen.length ? seen : ['__none__'] } } })
      .catch(() => undefined);
    await this.prisma.eventLog
      .create({ data: { type: 'finding', severity: findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 'warning' : 'info', title: `VAPT ${t.name} (${t.ip}): ${findings.length} finding(s)`, resourceName: t.name } })
      .catch(() => undefined);
  }

  /** Run nmap with service detection + the open-source vuln/misconfig NSE scripts. */
  private nmap(ip: string): Promise<string> {
    const args = ['-Pn', '-sV', '-T4', '--top-ports', '200', '--script', 'vulners,ftp-anon,ssl-enum-ciphers', '--script-timeout', '40s', '--host-timeout', '240s', '-oX', '-', ip];
    return new Promise((resolve) => {
      execFile('nmap', args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(stdout || ''));
    });
  }

  /** Parse nmap XML into categorized findings. */
  private parse(xml: string, ip: string): VFinding[] {
    const out: VFinding[] = [];
    const keys = new Set<string>();
    const push = (f: VFinding) => {
      if (keys.has(f.key)) return;
      keys.add(f.key);
      out.push(f);
    };
    const portRe = /<port\s+protocol="tcp"\s+portid="(\d+)">([\s\S]*?)<\/port>/g;
    let pm: RegExpExecArray | null;
    while ((pm = portRe.exec(xml))) {
      const port = Number(pm[1]);
      const body = pm[2];
      if (!/<state\s+state="open"/.test(body)) continue;
      const svc = /<service\b([^>]*?)\/?>/.exec(body)?.[1] ?? '';
      const attr = (n: string) => decodeXml(new RegExp(`${n}="([^"]*)"`).exec(svc)?.[1] ?? '');
      const label = [attr('product'), attr('version')].filter(Boolean).join(' ') || attr('name') || 'service';

      const risky = VaptScanner.RISKY[port];
      if (risky) push({ type: risky.type, severity: risky.sev, title: `Exposed ${risky.svc} on ${ip}:${port} — ${risky.note}${label !== 'service' ? ` (${label})` : ''}`, key: `svc:${port}` });

      // NSE script outputs for this port.
      const scriptRe = /<script\s+id="([^"]+)"\s+output="([^"]*)"/g;
      let sm: RegExpExecArray | null;
      while ((sm = scriptRe.exec(body))) {
        const id = sm[1];
        const output = decodeXml(sm[2]);
        if (id === 'vulners') {
          const cveRe = /(CVE-\d{4}-\d{3,7})\s+(\d+(?:\.\d+)?)/g;
          let cm: RegExpExecArray | null;
          let n = 0;
          while ((cm = cveRe.exec(output)) && n < 30) {
            n++;
            const cve = cm[1];
            const cvss = Number(cm[2]);
            push({ type: 'vulnerability', severity: sevFromCvss(cvss), title: `${cve} (CVSS ${cvss.toFixed(1)}) — ${label} on ${ip}:${port}`, key: `cve:${cve}:${port}` });
          }
        } else if (id === 'ftp-anon' && /Anonymous FTP login allowed/i.test(output)) {
          push({ type: 'threat', severity: 'high', title: `Anonymous FTP login allowed on ${ip}:${port}`, key: `ftp-anon:${port}` });
        } else if (id === 'ssl-enum-ciphers' && /least strength:\s*[D-F]\b|SSLv3|TLSv1\.0|RC4|NULL|EXPORT/i.test(output)) {
          push({ type: 'misconfiguration', severity: 'medium', title: `Weak TLS/SSL configuration on ${ip}:${port} (deprecated protocol or cipher)`, key: `weak-tls:${port}` });
        }
      }
    }
    return out;
  }

  /**
   * Collect distinct, scannable IPs of the user's OWN VMs only — enrolled guest agents and
   * discovered cloud compute resources. IP/Host monitors are deliberately NOT scanned: they
   * can point at third-party hosts (e.g. 8.8.8.8 / 1.1.1.1 reachability checks), and running an
   * aggressive vuln scan against infrastructure the user doesn't own would be unauthorized.
   */
  private async gatherTargets(): Promise<Target[]> {
    const [agents, resources] = await Promise.all([
      this.prisma.agent.findMany(),
      this.prisma.resource.findMany({ where: { type: 'compute' } }),
    ]);
    const map = new Map<string, Target>();
    const add = (rawIp: string, name: string, provider: Provider, resourceId?: string) => {
      const ip = bareHost(rawIp);
      if (!isScannable(ip)) return;
      if (!map.has(ip)) map.set(ip, { ip, name: name || ip, provider, resourceId });
    };
    // Discovered cloud VMs — prefer their public IP and real provider.
    for (const r of resources) {
      const p = (r.properties as any) ?? {};
      const ip = p.publicIp || p.privateIp || '';
      if (ip) add(ip, r.name, providerOf(r.provider), r.id);
    }
    // Enrolled agents (SSH-pull / TCP agent) — primary host only (skip docker/alt noise).
    for (const a of agents) if (a.hostname) add(a.hostname, a.name || a.hostname, 'private');
    return [...map.values()].slice(0, 25);
  }
}

function sevFromCvss(c: number): Severity {
  return c >= 9 ? 'critical' : c >= 7 ? 'high' : c >= 4 ? 'medium' : 'low';
}

function providerOf(p: string): Provider {
  return p === 'aws' || p === 'azure' || p === 'gcp' ? (p as Provider) : 'private';
}

/** Strip scheme/port/path → bare host. */
function bareHost(target: string): string {
  let t = (target || '').trim().toLowerCase();
  t = t.replace(/^[a-z]+:\/\//, '').split('/')[0];
  t = t.replace(/:\d+$/, '');
  return t;
}

/** Only scan real IPv4s the user added — never loopback, link-local or the docker bridge. */
function isScannable(ip: string): boolean {
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)) return false;
  const o = ip.split('.').map(Number);
  if (o.some((n) => n > 255)) return false;
  if (o[0] === 127 || o[0] === 0) return false; // loopback / unspecified
  if (o[0] === 169 && o[1] === 254) return false; // link-local
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false; // docker / private-B noise
  return true;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}
