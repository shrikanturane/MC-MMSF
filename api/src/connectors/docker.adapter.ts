import http from 'node:http';
import type { CloudAccountRef, CloudConnector, ControlContext, DiscoveredAsset, PowerAction, ProviderCredentials, TestResult } from './adapter';
import { runStages } from './adapter';

interface DockerContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: { PublicPort?: number; PrivatePort?: number; Type?: string }[];
  SizeRw?: number; // writable-layer bytes (needs ?size=1)
  SizeRootFs?: number; // total image+writable bytes
}

interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number; inactive_file?: number } };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

const MB = 1024 * 1024;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Real Docker connector (ported). Dependency-free: talks the Engine REST API over the unix
 * socket (or a TCP host). Credentials: { socketPath } (default /var/run/docker.sock) or
 * { host: 'tcp://host:2375' }. Each container becomes a canonical `container` asset.
 */
export class DockerConnector implements CloudConnector {
  readonly provider = 'docker';

  private target(c: ProviderCredentials) {
    const socketPath = c.socketPath ?? '/var/run/docker.sock';
    const tcpHost = c.host && c.host.startsWith('tcp://') ? c.host : undefined;
    return { socketPath, tcpHost };
  }

  async test(credentials: ProviderCredentials): Promise<TestResult> {
    const { socketPath, tcpHost } = this.target(credentials);
    return runStages([
      {
        name: `Connect to Docker engine (${tcpHost ?? socketPath})`,
        run: async () => {
          const info = await this.engineGet<{ Containers?: number; ServerVersion?: string }>('/info', socketPath, tcpHost);
          return `Docker ${info.ServerVersion ?? '?'} reachable (${info.Containers ?? 0} containers)`;
        },
      },
    ]);
  }

  async discover(_account: CloudAccountRef, credentials: ProviderCredentials): Promise<DiscoveredAsset[]> {
    const { socketPath, tcpHost } = this.target(credentials);
    // ?size=1 makes the engine report SizeRw / SizeRootFs (disk usage) per container.
    const containers = await this.engineGet<DockerContainer[]>('/containers/json?all=1&size=1', socketPath, tcpHost);

    return Promise.all(
      containers.map(async (c) => {
        const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
        const ports = (c.Ports ?? []).map((p) => p.PublicPort).filter((p): p is number => Boolean(p));
        const diskRwMB = c.SizeRw != null ? round1(c.SizeRw / MB) : null; // writable-layer delta
        const diskRootMB = c.SizeRootFs != null ? round1(c.SizeRootFs / MB) : null; // total footprint (image + writable)
        // Show the total footprint as "disk used" — SizeRw alone is usually ~0 (data lives in volumes).
        const diskUsedMB = diskRootMB ?? diskRwMB;

        // Live CPU% / memory only make sense for running containers.
        let cpuPct = 0;
        let memoryPct = 0;
        let memUsedMB: number | null = null;
        let memLimitMB: number | null = null;
        let netRxMB: number | null = null;
        let netTxMB: number | null = null;
        if ((c.State ?? '').toLowerCase() === 'running') {
          try {
            const s = await this.engineGet<DockerStats>(`/containers/${c.Id}/stats?stream=false`, socketPath, tcpHost);
            const m = this.computeStats(s);
            cpuPct = m.cpuPct;
            memoryPct = m.memPct;
            memUsedMB = m.memUsedMB;
            memLimitMB = m.memLimitMB;
            netRxMB = m.netRxMB;
            netTxMB = m.netTxMB;
          } catch {
            /* stats best-effort — keep the container even if stats fail */
          }
        }

        return {
          resourceType: 'container',
          externalId: `docker:${c.Id.slice(0, 12)}`,
          name,
          region: tcpHost ?? 'local',
          cpuPct,
          memoryPct,
          properties: {
            discoveredBy: 'docker-connector',
            image: c.Image,
            state: c.State,
            status: c.Status,
            ports: [...new Set(ports)],
            diskUsedMB,
            diskRwMB,
            diskRootMB,
            memUsedMB,
            memLimitMB,
            netRxMB,
            netTxMB,
          },
        } as DiscoveredAsset;
      }),
    );
  }

  /** Docker-stats CPU% + memory from a single (stream=false) sample, which carries precpu. */
  private computeStats(s: DockerStats): { cpuPct: number; memPct: number; memUsedMB: number; memLimitMB: number; netRxMB: number; netTxMB: number } {
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
    const cpuPct = sysDelta > 0 && cpuDelta > 0 ? round1((cpuDelta / sysDelta) * cpus * 100) : 0;

    const usageRaw = s.memory_stats?.usage ?? 0;
    const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
    const memUsed = Math.max(0, usageRaw - cache);
    const memLimit = s.memory_stats?.limit ?? 0;
    const memPct = memLimit > 0 ? round1((memUsed / memLimit) * 100) : 0;

    let rx = 0;
    let tx = 0;
    for (const n of Object.values(s.networks ?? {})) {
      rx += n.rx_bytes ?? 0;
      tx += n.tx_bytes ?? 0;
    }

    return {
      cpuPct,
      memPct,
      memUsedMB: round1(memUsed / MB),
      memLimitMB: round1(memLimit / MB),
      netRxMB: round1(rx / MB),
      netTxMB: round1(tx / MB),
    };
  }

  /** Power action on a container: start | stop | reboot(=restart). */
  async control(action: PowerAction, ctx: ControlContext, credentials: ProviderCredentials): Promise<{ ok: boolean; detail: string }> {
    const { socketPath, tcpHost } = this.target(credentials);
    const id = ctx.externalId.replace(/^docker:/, '');
    const verb = action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart';
    await this.enginePost(`/containers/${id}/${verb}?t=10`, socketPath, tcpHost);
    const past = verb === 'stop' ? 'stopped' : verb === 'start' ? 'started' : 'restarted';
    return { ok: true, detail: `Container ${ctx.name} ${past}.` };
  }

  private enginePost(path: string, socketPath: string, tcpHost?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const base: http.RequestOptions = tcpHost
        ? (() => {
            const u = new URL(tcpHost.replace('tcp://', 'http://'));
            return { host: u.hostname, port: Number(u.port) || 2375 };
          })()
        : { socketPath };
      const req = http.request(
        { ...base, path, method: 'POST', headers: { Host: 'docker', 'Content-Type': 'application/json' }, timeout: 20000 },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            const code = res.statusCode ?? 500;
            // 204 = done; 304 = already in that state (start an already-running / stop a stopped) — treat as success.
            if (code === 204 || code === 304) return resolve();
            reject(new Error(`docker engine ${code}: ${data.slice(0, 200)}`));
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('docker engine timeout')));
      req.end();
    });
  }

  private engineGet<T>(path: string, socketPath: string, tcpHost?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const base: http.RequestOptions = tcpHost
        ? (() => {
            const u = new URL(tcpHost.replace('tcp://', 'http://'));
            return { host: u.hostname, port: Number(u.port) || 2375 };
          })()
        : { socketPath };
      const req = http.request(
        { ...base, path, method: 'GET', headers: { Host: 'docker', Accept: 'application/json' }, timeout: 12000 },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 400) return reject(new Error(`docker engine ${res.statusCode}: ${data.slice(0, 200)}`));
            try {
              resolve(JSON.parse(data) as T);
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('docker engine timeout')));
      req.end();
    });
  }
}
