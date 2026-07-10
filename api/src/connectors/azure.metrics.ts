import type { ProviderCredentials } from './adapter';
import { getAzureToken } from './azure.auth';
import { emptyLatest, lastValue, round, type ResourceMetrics } from './metrics';

interface AzureMetricResp {
  value?: {
    name?: { value?: string };
    timeseries?: { data?: { timeStamp?: string; average?: number; total?: number }[] }[];
  }[];
}

const INTERVAL_SECONDS = 300; // PT5M

/**
 * Azure Monitor metrics for a VM resource (real, platform metrics — no guest agent required for
 * CPU/network/disk-throughput). Memory% and filesystem/disk-usage% require the Azure Monitor
 * agent (VM Insights); we surface Available Memory when present and note the rest.
 */
export class AzureMetrics {
  async collect(resourceId: string, creds: ProviderCredentials, hours = 1): Promise<ResourceMetrics> {
    const token = await getAzureToken(creds);
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600_000);
    const metricNames = [
      'Percentage CPU',
      'Network In Total',
      'Network Out Total',
      'Disk Read Bytes',
      'Disk Write Bytes',
      'Available Memory Bytes',
    ].join(',');

    const url =
      `https://management.azure.com${resourceId}/providers/microsoft.insights/metrics` +
      `?api-version=2018-01-01&metricnames=${encodeURIComponent(metricNames)}` +
      `&timespan=${start.toISOString()}/${end.toISOString()}&interval=PT5M&aggregation=Average,Total`;

    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      return { available: false, cpu: [], networkMbps: [], diskKBps: [], memoryAvailGB: null, latest: emptyLatest(), note: `Azure Monitor returned ${res.status}` };
    }
    const body = (await res.json()) as AzureMetricResp;
    const byName = new Map<string, { ts: string; average?: number; total?: number }[]>();
    for (const m of body.value ?? []) {
      const data = (m.timeseries?.[0]?.data ?? []).map((d) => ({ ts: d.timeStamp ?? '', average: d.average, total: d.total }));
      if (m.name?.value) byName.set(m.name.value, data);
    }

    const cpu = (byName.get('Percentage CPU') ?? []).map((d) => ({ ts: d.ts, value: round(d.average ?? 0) }));
    const netIn = byName.get('Network In Total') ?? [];
    const netOut = byName.get('Network Out Total') ?? [];
    const diskR = byName.get('Disk Read Bytes') ?? [];
    const diskW = byName.get('Disk Write Bytes') ?? [];
    const mem = byName.get('Available Memory Bytes') ?? [];

    const networkMbps = netIn.map((d, i) => {
      const bytes = (d.total ?? 0) + (netOut[i]?.total ?? 0);
      return { ts: d.ts, value: round((bytes * 8) / INTERVAL_SECONDS / 1e6, 2) };
    });
    const diskKBps = diskR.map((d, i) => {
      const bytes = (d.total ?? 0) + (diskW[i]?.total ?? 0);
      return { ts: d.ts, value: round(bytes / INTERVAL_SECONDS / 1024, 1) };
    });
    const memoryAvailGB = mem.length ? mem.map((d) => ({ ts: d.ts, value: round((d.average ?? 0) / 1024 ** 3, 2) })) : null;

    const last = lastValue;
    const note = memoryAvailGB
      ? undefined
      : 'Memory % and per-process/service breakdown require the Azure Monitor agent (VM Insights) on the VM.';

    return {
      available: cpu.length > 0 || networkMbps.length > 0,
      cpu,
      networkMbps,
      diskKBps,
      memoryAvailGB,
      latest: {
        cpuPct: last(cpu),
        networkMbps: last(networkMbps),
        diskKBps: last(diskKBps),
        memoryAvailGB: memoryAvailGB ? last(memoryAvailGB) : null,
      },
      note,
    };
  }
}
