import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { ProviderCredentials } from './adapter';
import { emptyLatest, lastValue, round, type ResourceMetrics, type TimePoint } from './metrics';

const PERIOD = 300; // 5-min

/**
 * Real CloudWatch metrics for an EC2 instance. CPU (Average %), Network In+Out (Sum bytes →
 * Mbps), Disk Read+Write (Sum bytes → KB/s). Memory needs the CloudWatch Agent on the host.
 */
export class AwsMetrics {
  async collect(instanceId: string, creds: ProviderCredentials, region: string, hours = 3): Promise<ResourceMetrics> {
    const cfg: any = { region };
    const endpoint = (creds.endpoint || process.env.AWS_ENDPOINT_URL || '').trim();
    if (endpoint) cfg.endpoint = endpoint;
    if (creds.accessKeyId && creds.secretAccessKey) {
      cfg.credentials = {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      };
    }
    const client = new CloudWatchClient(cfg);

    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600_000);
    const dim = [{ Name: 'InstanceId', Value: instanceId }];
    const q = (id: string, name: string, stat: string) => ({
      Id: id,
      MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: name, Dimensions: dim }, Period: PERIOD, Stat: stat },
      ReturnData: true,
    });

    try {
      const res = await client.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          ScanBy: 'TimestampAscending',
          MetricDataQueries: [
            q('cpu', 'CPUUtilization', 'Average'),
            q('netin', 'NetworkIn', 'Sum'),
            q('netout', 'NetworkOut', 'Sum'),
            q('dread', 'DiskReadBytes', 'Sum'),
            q('dwrite', 'DiskWriteBytes', 'Sum'),
            // Agent-based (CloudWatch Agent) — empty unless the agent is installed.
            { Id: 'mem', MetricStat: { Metric: { Namespace: 'CWAgent', MetricName: 'mem_used_percent', Dimensions: dim }, Period: PERIOD, Stat: 'Average' }, ReturnData: true },
            { Id: 'diskp', MetricStat: { Metric: { Namespace: 'CWAgent', MetricName: 'disk_used_percent', Dimensions: dim }, Period: PERIOD, Stat: 'Average' }, ReturnData: true },
          ],
        }),
      );
      const byId = new Map<string, { ts: string; v: number }[]>();
      for (const r of res.MetricDataResults ?? []) {
        const ts = r.Timestamps ?? [];
        const vals = r.Values ?? [];
        byId.set(r.Id ?? '', ts.map((t, i) => ({ ts: new Date(t).toISOString(), v: vals[i] ?? 0 })));
      }
      const cpu: TimePoint[] = (byId.get('cpu') ?? []).map((p) => ({ ts: p.ts, value: round(p.v) }));
      const netin = byId.get('netin') ?? [];
      const netout = byId.get('netout') ?? [];
      const dread = byId.get('dread') ?? [];
      const dwrite = byId.get('dwrite') ?? [];
      const networkMbps: TimePoint[] = netin.map((p, i) => ({
        ts: p.ts,
        value: round(((p.v + (netout[i]?.v ?? 0)) * 8) / PERIOD / 1e6, 2),
      }));
      const diskKBps: TimePoint[] = dread.map((p, i) => ({
        ts: p.ts,
        value: round((p.v + (dwrite[i]?.v ?? 0)) / PERIOD / 1024, 1),
      }));

      return {
        available: cpu.length > 0 || networkMbps.length > 0,
        cpu,
        networkMbps,
        diskKBps,
        memoryAvailGB: null,
        latest: {
          cpuPct: lastValue(cpu),
          networkMbps: lastValue(networkMbps),
          diskKBps: lastValue(diskKBps),
          memoryAvailGB: null,
          memoryPct: lastValue((byId.get('mem') ?? []).map((p) => ({ value: round(p.v) }))),
          diskPct: lastValue((byId.get('diskp') ?? []).map((p) => ({ value: round(p.v) }))),
        },
        note: 'Memory/disk % need the CloudWatch Agent on the instance. Core metrics appear when the instance is running.',
      };
    } catch (err) {
      return {
        available: false,
        cpu: [],
        networkMbps: [],
        diskKBps: [],
        memoryAvailGB: null,
        latest: emptyLatest(),
        note: `CloudWatch error: ${String((err as Error)?.message ?? err)}`,
      };
    }
  }
}
