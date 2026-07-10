import type { ProviderCredentials } from './adapter';
import { getGcpToken } from './gcp.auth';
import { emptyLatest, lastValue, round, type ResourceMetrics, type TimePoint } from './metrics';

interface GcpTimeSeriesResp {
  timeSeries?: {
    points?: { interval?: { endTime?: string }; value?: { doubleValue?: number; int64Value?: string } }[];
  }[];
}

/**
 * Real Cloud Monitoring metrics for a Compute Engine instance. CPU utilization (0-1 → %),
 * network received+sent bytes (→ Mbps). Dependency-free (REST + service-account token).
 */
export class GcpMetrics {
  async collect(instanceId: string, creds: ProviderCredentials, hours = 3): Promise<ResourceMetrics> {
    let token: string;
    let project: string;
    try {
      const r = await getGcpToken(creds);
      token = r.token;
      project = r.project;
    } catch (err) {
      return blank(`auth error: ${String((err as Error)?.message ?? err)}`);
    }

    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600_000);

    const series = async (metricType: string): Promise<{ ts: string; v: number }[]> => {
      const params = new URLSearchParams({
        filter: `metric.type="${metricType}" AND resource.labels.instance_id="${instanceId}"`,
        'interval.startTime': start.toISOString(),
        'interval.endTime': end.toISOString(),
        'aggregation.alignmentPeriod': '300s',
        'aggregation.perSeriesAligner': 'ALIGN_MEAN',
      });
      const res = await fetch(
        `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${params}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return [];
      const body = (await res.json()) as GcpTimeSeriesResp;
      const pts = body.timeSeries?.[0]?.points ?? [];
      // Cloud Monitoring returns newest-first; reverse to chronological.
      return pts
        .map((p) => ({
          ts: p.interval?.endTime ?? '',
          v: p.value?.doubleValue ?? Number(p.value?.int64Value ?? 0),
        }))
        .reverse();
    };

    try {
      const [cpuRaw, rxRaw, txRaw, memRaw, diskRaw] = await Promise.all([
        series('compute.googleapis.com/instance/cpu/utilization'),
        series('compute.googleapis.com/instance/network/received_bytes_count'),
        series('compute.googleapis.com/instance/network/sent_bytes_count'),
        series('agent.googleapis.com/memory/percent_used'), // Ops agent (empty if not installed)
        series('agent.googleapis.com/disk/percent_used'),
      ]);
      const cpu: TimePoint[] = cpuRaw.map((p) => ({ ts: p.ts, value: round(p.v * 100) }));
      const networkMbps: TimePoint[] = rxRaw.map((p, i) => ({
        ts: p.ts,
        value: round(((p.v + (txRaw[i]?.v ?? 0)) * 8) / 300 / 1e6, 2),
      }));

      return {
        available: cpu.length > 0 || networkMbps.length > 0,
        cpu,
        networkMbps,
        diskKBps: [],
        memoryAvailGB: null,
        latest: {
          cpuPct: lastValue(cpu),
          networkMbps: lastValue(networkMbps),
          diskKBps: null,
          memoryAvailGB: null,
          memoryPct: lastValue(memRaw.map((p) => ({ value: round(p.v) }))),
          diskPct: lastValue(diskRaw.map((p) => ({ value: round(p.v) }))),
        },
        note: 'Memory/disk % need the Ops Agent on the instance. Core metrics appear when the instance is running.',
      };
    } catch (err) {
      return blank(`Cloud Monitoring error: ${String((err as Error)?.message ?? err)}`);
    }
  }
}

function blank(note: string): ResourceMetrics {
  return { available: false, cpu: [], networkMbps: [], diskKBps: [], memoryAvailGB: null, latest: emptyLatest(), note };
}
