'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiDownload, apiGet, apiPatch, apiPost, apiPut } from './api';
import type {
  AlertingOverview,
  AlertItem,
  AlertRule,
  Dataset,
  DashWidget,
  CloudConnection,
  EscalationPolicy,
  Workflow,
  CommandCenterOverview,
  Incident,
  MonitoringOverview,
  ProviderSpec,
  ResourceDetailData,
  ResourceRow,
  ResourceTypes,
  SecurityOverview,
  SettingsData,
  TestResult,
  TimePoint,
  VmRow,
} from './types';

export const useManagementSummary = () =>
  useQuery({ queryKey: ['mgmt-summary'], queryFn: () => apiGet<import('./types').ManagementSummary>('/management/summary'), refetchInterval: 15000 });

export const useOsInventory = () =>
  useQuery({ queryKey: ['os-inventory'], queryFn: () => apiGet<import('./types').OsInventory>('/agent/os-inventory'), refetchInterval: 15000 });

// ── Compliance checklist ──────────────────────────────────────────
export const useComplianceItems = () =>
  useQuery({ queryKey: ['compliance-items'], queryFn: () => apiGet<import('./types').ComplianceItem[]>('/compliance/items') });

const useComplianceMutation = <T>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compliance-items'] });
      qc.invalidateQueries({ queryKey: ['mgmt-summary'] });
    },
  });
};
export const useComplianceCreate = () => useComplianceMutation((b: Record<string, unknown>) => apiPost('/compliance/items', b));
export const useComplianceUpdate = () => useComplianceMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/compliance/items/${id}`, b));
export const useComplianceDelete = () => useComplianceMutation((id: string) => apiDelete(`/compliance/items/${id}`));

export interface NotificationChannel {
  id: string;
  name: string;
  type: string;
  target: string;
  enabled: boolean;
}

export const useChannels = () =>
  useQuery({ queryKey: ['channels'], queryFn: () => apiGet<NotificationChannel[]>('/alerting/channels') });

// ── User groups / teams ───────────────────────────────────────────
export const useGroups = () =>
  useQuery({ queryKey: ['groups'], queryFn: () => apiGet<import('./types').GroupItem[]>('/groups') });
const useGroupMutation = <T>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }) });
};
export const useCreateGroup = () => useGroupMutation((b: Record<string, unknown>) => apiPost('/groups', b));
export const useUpdateGroup = () => useGroupMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/groups/${id}`, b));
export const useDeleteGroup = () => useGroupMutation((id: string) => apiDelete(`/groups/${id}`));
export const useAddGroupMember = () => useGroupMutation(({ groupId, userId }: { groupId: string; userId: string }) => apiPost(`/groups/${groupId}/members`, { userId }));
export const useRemoveGroupMember = () => useGroupMutation(({ groupId, userId }: { groupId: string; userId: string }) => apiDelete(`/groups/${groupId}/members/${userId}`));

// ── Integrations config + notification delivery monitoring ────────
export const useIntegrations = () =>
  useQuery({ queryKey: ['integrations'], queryFn: () => apiGet<import('./types').IntegrationField[]>('/integrations') });
export const useUpdateIntegrations = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: Record<string, string>) => apiPatch('/integrations', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations'] }) });
};
export const useTestIntegration = () =>
  useMutation({ mutationFn: ({ provider, to }: { provider: string; to?: string }) => apiPost<{ ok: boolean; detail: string }>(`/integrations/${provider}/test`, { to }) });
export const useRemoveIntegration = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (provider: string) => apiDelete(`/integrations/${provider}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations'] }) });
};
export interface IntegrationHealth { provider: string; ok: boolean; detail: string; at: string }
export const useIntegrationsHealth = () =>
  useQuery({ queryKey: ['integration-health'], queryFn: () => apiGet<IntegrationHealth[]>('/integrations/health'), retry: false, refetchInterval: 60000 });

// ── Open API keys (3rd-party ITSM / monitoring integration) ──
export interface ApiKeyRow { id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
export const useApiKeys = () =>
  useQuery({ queryKey: ['api-keys'], queryFn: () => apiGet<ApiKeyRow[]>('/integration/keys') });
export const useCreateApiKey = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: { name: string; scopes?: string[] }) => apiPost<{ id: string; name: string; scopes: string[]; key: string; note: string }>('/integration/keys', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }) });
};
export const useRevokeApiKey = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiDelete(`/integration/keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }) });
};

// ── TLS / certificate management ──
export interface TlsStatus { present: boolean; selfSigned?: boolean; subject?: string; issuer?: string; sans?: string[]; hasSan?: boolean; notAfter?: string | null; daysLeft?: number | null; cn?: string | null; error?: string }
export const useTlsStatus = () =>
  useQuery({ queryKey: ['tls-status'], queryFn: () => apiGet<TlsStatus>('/tls/status') });
export const useRegenerateTls = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: { cn: string; sans?: string[] }) => apiPost<TlsStatus & { ok: boolean; reloaded: boolean }>('/tls/regenerate', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['tls-status'] }) });
};
export const useDownloadCert = () => useMutation({ mutationFn: () => apiDownload('/tls/cert', 'mcmf.crt') });
export const useDownloadCertInstaller = () => useMutation({ mutationFn: (host: string) => apiDownload(`/tls/install-script?host=${encodeURIComponent(host)}`, 'mcmf-install-cert.ps1') });
// Custom domain via Let's Encrypt (ACME DNS-01)
export interface TlsDomainStatus { pending: boolean; domain?: string; staging?: boolean; recordType?: string; recordName?: string; recordValue?: string; createdAt?: string }
export const useTlsDomainStatus = () => useQuery({ queryKey: ['tls-domain'], queryFn: () => apiGet<TlsDomainStatus>('/tls/domain/status') });
export const useStartTlsDomain = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: { domain: string; email?: string; staging?: boolean }) => apiPost<TlsDomainStatus & { ok: boolean }>('/tls/domain/start', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['tls-domain'] }) });
};
export const useValidateTlsDomain = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost<{ ok: boolean; domain: string } & TlsStatus>('/tls/domain/validate', {}), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tls-domain'] }); qc.invalidateQueries({ queryKey: ['tls-status'] }); } });
};
export const useCancelTlsDomain = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost('/tls/domain/cancel', {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['tls-domain'] }) });
};
// ── Domain management (HTTPS + email DKIM/SPF/DMARC) ──
export interface DnsRecord { type: string; name: string; value: string }
export interface DomainItem { id: string; domain: string; httpsEnabled: boolean; certExpiry: string | null; emailEnabled: boolean; emailVerified: boolean; emailFrom: string; dkimSelector: string; active: boolean; records: { dkim: DnsRecord | null; spf: DnsRecord; dmarc: DnsRecord } | null }
export interface DomainList { serverIp: string; domains: DomainItem[] }
export const useDomains = () => useQuery({ queryKey: ['domains'], queryFn: () => apiGet<DomainList>('/domains') });
const useDomainMutation = <T,>(fn: (a: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => { qc.invalidateQueries({ queryKey: ['domains'] }); qc.invalidateQueries({ queryKey: ['tls-status'] }); } });
};
export const useAddDomain = () => useDomainMutation((domain: string) => apiPost('/domains', { domain }));
export const useRemoveDomain = () => useDomainMutation((id: string) => apiDelete(`/domains/${id}`));
export const useDomainEmailSetup = () => useDomainMutation((id: string) => apiPost(`/domains/${id}/email/setup`, {}));
export const useDomainEmailVerify = () => useDomainMutation((id: string) => apiPost(`/domains/${id}/email/verify`, {}));
export const useDomainEmailActive = () => useDomainMutation(({ id, active }: { id: string; active: boolean }) => apiPost(`/domains/${id}/email/active`, { active }));
export const useDomainHttpsStatus = () => useQuery({ queryKey: ['tls-domain'], queryFn: () => apiGet<TlsDomainStatus>('/domains/https/status') });
export const useDomainHttpsStart = () => { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => apiPost<TlsDomainStatus & { ok: boolean }>(`/domains/${id}/https/start`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['tls-domain'] }) }); };
export const useDomainHttpsValidate = () => { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => apiPost(`/domains/${id}/https/validate`, {}), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tls-domain'] }); qc.invalidateQueries({ queryKey: ['domains'] }); qc.invalidateQueries({ queryKey: ['tls-status'] }); } }); };
export const useDomainHttpsCancel = () => { const qc = useQueryClient(); return useMutation({ mutationFn: () => apiPost('/domains/https/cancel', {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['tls-domain'] }) }); };
// ── Platform domain (one per server) ──
export interface PlatformStatus { serverIp: string; domain: string; mode: '' | 'letsencrypt' | 'upload' | 'upstream'; cert: { present: boolean; cn: string | null; sans: string[]; selfSigned: boolean; daysLeft: number | null }; coversDomain: boolean; httpsLive: boolean; trusted: boolean }
export const usePlatformDomain = () => useQuery({ queryKey: ['platform-domain'], queryFn: () => apiGet<PlatformStatus>('/domains/platform') });
const usePlatformMut = <T,>(fn: (a: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => { ['platform-domain', 'tls-status', 'tls-domain'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); } });
};
export const usePlatformUpstream = () => usePlatformMut((domain: string) => apiPost('/domains/platform/upstream', { domain }));
export const usePlatformUpload = () => usePlatformMut((b: { domain: string; certPem: string; keyPem: string }) => apiPost('/domains/platform/upload', b));
export const usePlatformLeStart = () => { const qc = useQueryClient(); return useMutation({ mutationFn: (domain: string) => apiPost<TlsDomainStatus & { ok: boolean }>('/domains/platform/le/start', { domain }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tls-domain'] }) }); };
export const usePlatformLeValidate = () => usePlatformMut((domain: string) => apiPost('/domains/platform/le/validate', { domain }));
export const useClearPlatform = () => usePlatformMut(() => apiDelete('/domains/platform'));
export const useRunIntegrationHealth = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost<IntegrationHealth[]>('/integrations/health/run'), onSuccess: () => qc.invalidateQueries({ queryKey: ['integration-health'] }) });
};
export const useDeliveries = () =>
  useQuery({ queryKey: ['deliveries'], queryFn: () => apiGet<import('./types').DeliveryItem[]>('/alerting/deliveries'), refetchInterval: 10000 });
export const useRetryDelivery = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiPost<{ ok: boolean; error: string | null }>(`/alerting/deliveries/${id}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }) });
};
export const useDeleteDelivery = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiDelete(`/alerting/deliveries/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }) });
};
export const useTestChannel = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiPost<{ ok: boolean; error: string | null }>(`/alerting/channels/${id}/test`), onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }) });
};

export const useCreateChannel = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: Record<string, unknown>) => apiPost('/alerting/channels', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
};

export const useUpdateChannel = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/alerting/channels/${id}`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
};

export const useDeleteChannel = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/alerting/channels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
};

export const useMonitoring = () =>
  useQuery({ queryKey: ['monitoring'], queryFn: () => apiGet<MonitoringOverview>('/monitoring/overview') });

export const useTimeseries = (metric: 'cpu' | 'memory' | 'disk' | 'network' | 'latency' | 'jitter' | 'error', vm = 'all') =>
  useQuery({
    queryKey: ['timeseries', metric, vm],
    queryFn: () => apiGet<TimePoint[]>(`/monitoring/timeseries?metric=${metric}${vm && vm !== 'all' ? `&vm=${encodeURIComponent(vm)}` : ''}`),
    refetchInterval: 30000,
  });

export const useIncidents = () =>
  useQuery({ queryKey: ['incidents'], queryFn: () => apiGet<Incident[]>('/monitoring/incidents') });

export const useTelemetry = () =>
  useQuery({ queryKey: ['telemetry'], queryFn: () => apiGet<import('./types').VmTelemetry[]>('/monitoring/telemetry'), refetchInterval: 12000 });

export const useSystemEvents = () =>
  useQuery({ queryKey: ['system-events'], queryFn: () => apiGet<import('./types').SystemEvent[]>('/monitoring/events'), refetchInterval: 12000 });

export const useSecurity = () =>
  useQuery({ queryKey: ['security'], queryFn: () => apiGet<SecurityOverview>('/security/overview') });

export interface VaptRuleset {
  method: string;
  categories: string[];
  process: string[];
  rules: { check: string; port: number | null; type: string; severity: string; note: string }[];
}
export const useVaptRules = () =>
  useQuery({ queryKey: ['vapt-rules'], queryFn: () => apiGet<VaptRuleset>('/security/vapt/rules'), staleTime: 600_000 });

export interface FindingRow {
  id: string;
  title: string;
  type: string;
  severity: import('./format').Severity;
  status: string;
  provider: import('./format').Provider;
  source: string | null;
  resourceName: string | null;
  detectedAt: string;
}

export const useSecurityFindings = (params: { type?: string; severity?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.type) qs.set('type', params.type);
  if (params.severity) qs.set('severity', params.severity);
  const q = qs.toString();
  return useQuery({
    queryKey: ['security-findings', params],
    queryFn: () => apiGet<FindingRow[]>(`/security/findings${q ? `?${q}` : ''}`),
  });
};

export const useRefreshFindings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ ok: boolean; total: number; results: any[] }>('/security/refresh'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['security'] });
      qc.invalidateQueries({ queryKey: ['security-findings'] });
    },
  });
};

/** Kick off an external VAPT (open-source Nmap) scan of every enrolled VM. */
export const useRunVapt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ ok: boolean; started: boolean; targets: number; ips: string[]; message: string }>('/security/vapt'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['security'] });
      qc.invalidateQueries({ queryKey: ['security-findings'] });
    },
  });
};

export const useVaptStatus = (enabled = false) =>
  useQuery({ queryKey: ['vapt-status'], queryFn: () => apiGet<{ scanning: boolean }>('/security/vapt/status'), refetchInterval: enabled ? 5000 : false });

export const useResourceTypes = () =>
  useQuery({ queryKey: ['resource-types'], queryFn: () => apiGet<ResourceTypes>('/inventory/resource-types') });

export const useResources = (filters: { provider?: string; type?: string; q?: string }) => {
  const qs = new URLSearchParams();
  if (filters.provider && filters.provider !== 'all') qs.set('provider', filters.provider);
  if (filters.type && filters.type !== 'all') qs.set('type', filters.type);
  if (filters.q) qs.set('q', filters.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['resources', filters],
    queryFn: () => apiGet<ResourceRow[]>(`/inventory/resources${query ? `?${query}` : ''}`),
  });
};

export const useResourceDetail = (id: string | null) =>
  useQuery({
    queryKey: ['resource-detail', id],
    queryFn: () => apiGet<ResourceDetailData>(`/inventory/resources/${id}`),
    enabled: !!id,
    refetchInterval: 30000,
  });

// ── Alerting engine (Secure pillar) ───────────────────────────────
const invalidateAlerting = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['alerting-overview'] });
  qc.invalidateQueries({ queryKey: ['alert-rules'] });
  qc.invalidateQueries({ queryKey: ['alerts'] });
  qc.invalidateQueries({ queryKey: ['workflows'] });
  qc.invalidateQueries({ queryKey: ['escalations'] });
};

export const useAlertingOverview = () =>
  useQuery({ queryKey: ['alerting-overview'], queryFn: () => apiGet<AlertingOverview>('/alerting/overview'), refetchInterval: 10000 });

export const useAlerts = (status?: string) =>
  useQuery({
    queryKey: ['alerts', status ?? 'all'],
    queryFn: () => apiGet<AlertItem[]>(`/alerting/alerts${status ? `?status=${status}` : ''}`),
    refetchInterval: 10000,
  });

export const useAlertRules = () =>
  useQuery({ queryKey: ['alert-rules'], queryFn: () => apiGet<AlertRule[]>('/alerting/rules') });

export const useWorkflows = () =>
  useQuery({ queryKey: ['workflows'], queryFn: () => apiGet<Workflow[]>('/alerting/workflows') });

export const useEscalations = () =>
  useQuery({ queryKey: ['escalations'], queryFn: () => apiGet<EscalationPolicy[]>('/alerting/escalations') });

export const useAlertingMutation = <T>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidateAlerting(qc) });
};

export const useTestRuleNotify = () =>
  useMutation({ mutationFn: (b: Record<string, unknown>) => apiPost<{ results: { channel: string; ok: boolean; detail: string }[]; allOk: boolean }>('/alerting/rules/test', b) });
export const useCreateRule = () => useAlertingMutation((b: Record<string, unknown>) => apiPost('/alerting/rules', b));
export const useUpdateRule = () => useAlertingMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/alerting/rules/${id}`, b));
export const useDeleteRule = () => useAlertingMutation((id: string) => apiDelete(`/alerting/rules/${id}`));

export const useCreateWorkflow = () => useAlertingMutation((b: Record<string, unknown>) => apiPost('/alerting/workflows', b));
export const useUpdateWorkflow = () => useAlertingMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/alerting/workflows/${id}`, b));
export const useDeleteWorkflow = () => useAlertingMutation((id: string) => apiDelete(`/alerting/workflows/${id}`));

export const useCreateEscalation = () => useAlertingMutation((b: Record<string, unknown>) => apiPost('/alerting/escalations', b));
export const useUpdateEscalation = () => useAlertingMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/alerting/escalations/${id}`, b));
export const useDeleteEscalation = () => useAlertingMutation((id: string) => apiDelete(`/alerting/escalations/${id}`));

export const useAckAlert = () => useAlertingMutation((id: string) => apiPost(`/alerting/alerts/${id}/acknowledge`));
export const useResolveAlert = () => useAlertingMutation((id: string) => apiPost(`/alerting/alerts/${id}/resolve`));
export const useEvaluateNow = () => useAlertingMutation(() => apiPost('/alerting/evaluate'));

// ── Custom dashboard ──────────────────────────────────────────────
export const useDatasets = () =>
  useQuery({ queryKey: ['datasets'], queryFn: () => apiGet<Dataset[]>('/dashboard/datasets'), refetchInterval: 15000 });

// Keyed board layouts (drag/resize). key = 'custom' | 'monitoring'.
export const useBoardLayout = (key: string) =>
  useQuery({ queryKey: ['board', key], queryFn: () => apiGet<{ panels: any[] }>(`/dashboard/layout?key=${key}`) });

export const useSaveBoardLayout = (_key: string) =>
  // NOTE: deliberately does NOT invalidate the board query — the board owns local
  // panel state; refetching here caused a save→refetch→reset loop (UI hang).
  useMutation({ mutationFn: (panels: any[]) => apiPut('/dashboard/layout', { key: _key, panels }) });

// IP / host monitors
export const useMonitors = () =>
  useQuery({ queryKey: ['monitors'], queryFn: () => apiGet<import('./types').MonitorItem[]>('/monitors'), refetchInterval: 15000 });

// Network devices (firewall/router/switch) — SNMP telemetry for the Network Devices widget.
export const useNetworkDevices = () =>
  useQuery({ queryKey: ['network-devices'], queryFn: () => apiGet<import('./types').NetworkDevice[]>('/monitors/network'), refetchInterval: 15000 });

export const useSnmpPoll = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<{ ok: boolean; status: string; interfaces?: number; connected?: number; message: string }>(`/monitors/${id}/snmp-poll`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['network-devices'] }); qc.invalidateQueries({ queryKey: ['monitors'] }); },
  });
};

export const useCreateMonitor = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: Record<string, unknown>) => apiPost('/monitors', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['monitors'] }) });
};
export const useUpdateMonitor = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/monitors/${id}`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ['monitors'] }) });
};
export const useDeleteMonitor = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiDelete(`/monitors/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['monitors'] }) });
};
export const useCheckMonitors = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost('/monitors/check'), onSuccess: () => qc.invalidateQueries({ queryKey: ['monitors'] }) });
};

export const useVms = () =>
  useQuery({ queryKey: ['vms'], queryFn: () => apiGet<VmRow[]>('/inventory/vms'), refetchInterval: 10000 });

export const useControlVm = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'reboot' }) =>
      apiPost<{ ok: boolean; detail: string }>(`/inventory/resources/${id}/action`, { action }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vms'] });
      qc.invalidateQueries({ queryKey: ['resources'] });
    },
  });
};

export const useDeleteResource = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean; name: string; provider: string; willReturn: boolean; note: string }>(`/inventory/resources/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vms'] });
      qc.invalidateQueries({ queryKey: ['resources'] });
      qc.invalidateQueries({ queryKey: ['topology'] });
    },
  });
};

export const useCommandCenter = () =>
  useQuery({
    queryKey: ['command-center'],
    queryFn: () => apiGet<CommandCenterOverview>('/command-center/overview'),
    refetchInterval: 8000,
  });

export const useSettings = () =>
  useQuery({ queryKey: ['settings'], queryFn: () => apiGet<SettingsData>('/settings') });

// ── Network access blocklist (admin) ──────────────────────────────
export interface BlocklistEntry { type: 'ip' | 'cidr' | 'range'; value: string; note?: string; enabled?: boolean }
export type CountryMode = 'off' | 'allow' | 'block';
export interface BlocklistData { enabled: boolean; entries: BlocklistEntry[]; countryMode: CountryMode; countryList: string[]; yourIp: string; yourCountry: string | null }
export const useBlocklist = () =>
  useQuery({ queryKey: ['blocklist'], queryFn: () => apiGet<BlocklistData>('/settings/blocklist') });
export const useUpdateBlocklist = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: { enabled: boolean; entries: BlocklistEntry[]; countryMode: CountryMode; countryList: string[] }) => apiPut('/settings/blocklist', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['blocklist'] }) });
};

// ── Encrypted backup / restore (admin) ────────────────────────────
export interface BackupCounts { connections: number; vault: number; channels: number; integrations: number }
export const useBackup = () => useMutation({ mutationFn: (passphrase: string) => apiPost<{ file: string; counts: BackupCounts }>('/backup', { passphrase }) });
export const useRestore = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: { file: string; passphrase: string }) => apiPost<{ ok: boolean; restored: BackupCounts; exportedAt: string | null }>('/backup/restore', b), onSuccess: () => qc.invalidateQueries() });
};

// ── Policy & Environment Governance ───────────────────────────────
export const usePolicies = () =>
  useQuery({ queryKey: ['policies'], queryFn: () => apiGet<import('./types').Policy[]>('/policies'), refetchInterval: 30000 });

export const usePolicyEnvironments = () =>
  useQuery({ queryKey: ['policy-environments'], queryFn: () => apiGet<import('./types').EnvironmentSummary>('/policies/environments'), refetchInterval: 30000 });

export const usePolicyViolations = (policyId?: string) =>
  useQuery({ queryKey: ['policy-violations', policyId ?? 'all'], queryFn: () => apiGet<import('./types').PolicyViolation[]>(`/policies/violations${policyId ? `?policyId=${policyId}` : ''}`) });

const usePolicyMutation = <T>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['policies'] });
      qc.invalidateQueries({ queryKey: ['policy-environments'] });
      qc.invalidateQueries({ queryKey: ['policy-violations'] });
    },
  });
};
export const useCreatePolicy = () => usePolicyMutation((b: Record<string, unknown>) => apiPost('/policies', b));
export const useUpdatePolicy = () => usePolicyMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/policies/${id}`, b));
export const useDeletePolicy = () => usePolicyMutation((id: string) => apiDelete(`/policies/${id}`));
export const useEvaluatePolicies = () => usePolicyMutation(() => apiPost('/policies/evaluate'));

// ── Customizable Reports ──────────────────────────────────────────
export const useReports = () =>
  useQuery({ queryKey: ['reports'], queryFn: () => apiGet<import('./types').ReportItem[]>('/reports'), refetchInterval: 30000 });
export const useReportSources = () =>
  useQuery({ queryKey: ['report-sources'], queryFn: () => apiGet<import('./types').ReportSource[]>('/reports/sources'), staleTime: Infinity });
export const useReportRuns = (id: string | null) =>
  useQuery({ queryKey: ['report-runs', id], queryFn: () => apiGet<import('./types').ReportRun[]>(`/reports/${id}/runs`), enabled: !!id });

const useReportMutation = <T>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['reports'] }) });
};
export const useCreateReport = () => useReportMutation((b: Record<string, unknown>) => apiPost('/reports', b));
export const useUpdateReport = () => useReportMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/reports/${id}`, b));
export const useDeleteReport = () => useReportMutation((id: string) => apiDelete(`/reports/${id}`));
export const useRunReport = () =>
  useMutation({ mutationFn: (id: string) => apiPost<{ columns: string[]; rows: Record<string, any>[] }>(`/reports/${id}/run`) });
export const downloadReport = (id: string, name: string) => apiDownload(`/reports/${id}/download`, `${name}.csv`);

// ── Approval Process Control ──────────────────────────────────────
export const useApprovals = (status?: string) =>
  useQuery({ queryKey: ['approvals', status ?? 'all'], queryFn: () => apiGet<import('./types').ApprovalRequest[]>(`/approvals${status ? `?status=${status}` : ''}`), refetchInterval: 12000 });
export const useApprovalPolicies = () =>
  useQuery({ queryKey: ['approval-policies'], queryFn: () => apiGet<import('./types').ApprovalPolicy[]>('/approvals/policies') });

const useApprovalMutation = <T>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['approval-policies'] });
      qc.invalidateQueries({ queryKey: ['vms'] });
    },
  });
};
export const useApproveRequest = () => useApprovalMutation((id: string) => apiPost(`/approvals/${id}/approve`));
export const useRejectRequest = () => useApprovalMutation(({ id, note }: { id: string; note?: string }) => apiPost(`/approvals/${id}/reject`, { note }));
export const useRetryRequest = () => useApprovalMutation((id: string) => apiPost<{ ok: boolean; status: string; result: string }>(`/approvals/${id}/retry`));
export const useSetApprovalPolicy = () => useApprovalMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/approvals/policies/${id}`, b));
export const useCreateApprovalPolicy = () => useApprovalMutation((b: Record<string, unknown>) => apiPost('/approvals/policies', b));
export const useDeleteApprovalPolicy = () => useApprovalMutation((id: string) => apiDelete(`/approvals/policies/${id}`));

// ── Network Analysis ──────────────────────────────────────────────
export const useNetworkOverview = () =>
  useQuery({ queryKey: ['network'], queryFn: () => apiGet<import('./types').NetworkOverview>('/network/overview'), refetchInterval: 30000 });
export const useNetworkScan = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost<import('./types').NetworkOverview>('/network/scan'), onSuccess: (d) => qc.setQueryData(['network'], d) });
};
// ── Event Tracking / Activity ─────────────────────────────────────
export const useActivity = (f: { type?: string; severity?: string; provider?: string; q?: string } = {}) => {
  const qs = new URLSearchParams();
  if (f.type && f.type !== 'all') qs.set('type', f.type);
  if (f.severity && f.severity !== 'all') qs.set('severity', f.severity);
  if (f.provider && f.provider !== 'all') qs.set('provider', f.provider);
  if (f.q) qs.set('q', f.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['activity', f], queryFn: () => apiGet<import('./types').ActivityEvent[]>(`/activity${query ? `?${query}` : ''}`), refetchInterval: 12000 });
};
export const useActivitySummary = () =>
  useQuery({ queryKey: ['activity-summary'], queryFn: () => apiGet<import('./types').ActivitySummary>('/activity/summary'), refetchInterval: 15000 });
export const useResourceTimeline = (name: string | null) =>
  useQuery({ queryKey: ['resource-timeline', name], queryFn: () => apiGet<import('./types').ResourceTimeline>(`/activity/resource/${encodeURIComponent(name!)}`), enabled: !!name });
export const useActivityPredictive = () =>
  useQuery({ queryKey: ['activity-predictive'], queryFn: () => apiGet<import('./types').PredictiveData>('/activity/predictive'), refetchInterval: 30000 });
export const useSiemStream = (limit = 120) =>
  useQuery({ queryKey: ['activity-siem', limit], queryFn: () => apiGet<import('./types').SiemEventItem[]>(`/activity/siem?limit=${limit}`), refetchInterval: 12000 });
export const useAuditTrail = (limit = 120) =>
  useQuery({ queryKey: ['activity-audit', limit], queryFn: () => apiGet<import('./types').AuditItem[]>(`/activity/audit?limit=${limit}`), refetchInterval: 30000 });

export const useNetworkMonitoring = () =>
  useQuery({ queryKey: ['network-monitoring'], queryFn: () => apiGet<import('./types').NetworkMonitoringData>('/network/monitoring'), refetchInterval: 15000 });
export const useTopology = () =>
  useQuery({ queryKey: ['topology'], queryFn: () => apiGet<import('./types').TopologyData>('/network/topology'), refetchInterval: 20000 });
export const useProvisionRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: Record<string, unknown>) => apiPost<{ ok: boolean; requestId: string }>('/network/provision', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  });
};
export const useGrantScripts = () =>
  useQuery({ queryKey: ['grant-scripts'], queryFn: () => apiGet<import('./types').GrantScript[]>('/network/provision/grant-scripts'), retry: false, staleTime: 60000 });
export const useRevealGrantScripts = () =>
  useMutation({ mutationFn: (code: string) => apiPost<import('./types').GrantScript[]>('/network/provision/grant-scripts/reveal', { code }) });
export const useAgentInstall = () =>
  useQuery({ queryKey: ['agent-install'], queryFn: () => apiGet<{ ingestUrl: string; key: string; linuxPrep: string; windowsPrep: string; windowsExeAgent: string; windowsTrayAgent: string; linuxTcpAgent: string; linuxService: string; windowsService: string; ports: { dir: string; from: string; to: string; proto: string; port: string; why: string }[] }>('/agent/install'), retry: false, staleTime: 60000 });

export interface AgentInfo {
  id: string;
  name: string;
  displayName?: string | null;
  machineName?: string | null;
  group?: string | null;
  version?: string | null;
  currentVersion?: string | null;
  outdated?: boolean;
  hostname: string | null;
  os: string | null;
  ips: string[];
  resourceId: string | null;
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
  netMbps: number | null;
  diskIoKbps?: number | null;
  services: { name: string; status: string; cpu?: number; mem?: number; diskKbps?: number }[];
  active: boolean;
  mode: string;
  outbound?: boolean;
  intervalSec: number;
  lastSeenAt: string | null;
  online: boolean;
}
export const useAgents = () =>
  useQuery({ queryKey: ['agents'], queryFn: () => apiGet<AgentInfo[]>('/agent'), refetchInterval: 15000 });
export const useAgentBootstrapCommand = () => useQuery({ queryKey: ['agent-bootstrap-cmd'], queryFn: () => apiGet<{ url: string; command: string }>('/agent/bootstrap-command'), staleTime: 300_000 });
export const useAgentPullNow = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiPost<{ ok: boolean; reachable?: boolean; message?: string }>(`/agent/${id}/pull-now`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['command-center'] }); } });
};
export const useAgentPushAgent = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...b }: { id: string; port?: number; username?: string; password?: string }) => apiPost<{ ok: boolean; verified: boolean; install: string; port: number; host: string; message: string }>(`/agent/${id}/push-agent`, b), onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['command-center'] }); qc.invalidateQueries({ queryKey: ['monitors'] }); } });
};
export const useUpdateAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...b }: { id: string; active?: boolean; intervalSec?: number; host?: string; altHosts?: string; port?: number; username?: string; password?: string; os?: string; displayName?: string; group?: string }) => apiPatch(`/agent/${id}`, b),
    // The group lives on the mirrored monitor — so changing it must refresh the monitor & network-device
    // views too, keeping Guest Agents, IP/Host Monitor and Network Devices in lockstep on one scope.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['command-center'] }); qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['monitors'] }); qc.invalidateQueries({ queryKey: ['network-devices'] }); },
  });
};
/** Queue a command for an outbound agent (e.g. kind:'update' → remote self-update / push). */
export const useEnqueueAgentCommand = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kind, payload }: { id: string; kind: string; payload?: Record<string, unknown> }) => apiPost(`/agent/${id}/command`, { kind, payload }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['command-center'] }); qc.invalidateQueries({ queryKey: ['agents'] }); },
  });
};
export const useRemoveAgent = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiDelete(`/agent/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['command-center'] }) });
};
// Shut down + uninstall an outbound agent: it removes its own service + files and drops off the list.
export const useShutdownAgent = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiPost<{ ok: boolean; message: string }>(`/agent/${id}/shutdown`, {}), onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['command-center'] }); } });
};
export const useEnrollPull = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: { host: string; altHosts?: string; port?: number; username?: string; password?: string; intervalSec?: number; os?: string; mode?: string; pullKey?: string; group?: string }) => apiPost<{ ok: boolean; pullKey?: string }>('/agent/pull', b), onSuccess: () => { qc.invalidateQueries({ queryKey: ['command-center'] }); qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['monitors'] }); } });
};
export interface VaultEntry {
  id: string;
  host: string;
  protocol: string;
  username: string;
  kind: string;
  label: string;
  updatedAt: string;
}
export const useVault = () =>
  useQuery({ queryKey: ['vault'], queryFn: () => apiGet<VaultEntry[]>('/vault') });
export const useRevealCredential = () =>
  useMutation({ mutationFn: ({ id, code }: { id: string; code: string }) => apiPost<{ password: string; host: string; username: string }>(`/vault/${id}/reveal`, { code }) });
const useVaultMutation = <T>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['vault'] }) });
};
export const useUpsertCredential = () => useVaultMutation((b: Record<string, unknown>) => apiPost('/vault', b));
export const useUpdateCredential = () => useVaultMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/vault/${id}`, b));
export const useDeleteCredential = () => useVaultMutation((id: string) => apiDelete(`/vault/${id}`));

export const useZeroTrust = () =>
  useQuery({ queryKey: ['zerotrust'], queryFn: () => apiGet<import('./types').ZeroTrustPosture>('/zerotrust/posture'), refetchInterval: 60000 });
export const useZtWorkloads = () =>
  useQuery({ queryKey: ['zerotrust-workloads'], queryFn: () => apiGet<import('./types').ZtWorkloads>('/zerotrust/workloads'), refetchInterval: 30000 });
export const useZtRemediate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pillar: string) => apiPost<{ ok: boolean; attempted: number; results: { resource: string; detail: string }[] }>('/zerotrust/remediate', { pillar }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['zerotrust'] }); qc.invalidateQueries({ queryKey: ['network'] }); },
  });
};
export const useAiStatus = () =>
  useQuery({ queryKey: ['ai-status'], queryFn: () => apiGet<{ configured: boolean; model: string | null; provider: string; providerLabel: string; llm: boolean; local: boolean }>('/ai/status'), retry: false, staleTime: 30000 });
export const useAiHealth = () =>
  useQuery({ queryKey: ['ai-health'], queryFn: () => apiGet<{ ok: boolean; enabled: boolean; model: string; present?: boolean; models?: string[]; detail?: string }>('/ai/health'), retry: false, refetchInterval: 30000 });
export const useAiAssistant = () =>
  useMutation({ mutationFn: (prompt: string) => apiPost<{ configured: boolean; answer: string; model?: string }>('/ai/assistant', { prompt }) });
export const useRca = () =>
  useMutation({ mutationFn: (b: { alertId?: string; incidentId?: string }) => apiPost<{ source: string; model?: string; narrative: string; evidence: string[] }>('/ai/rca', b) });
export const useAiAnalyze = () =>
  useMutation({ mutationFn: (scope: string) => apiPost<{ scope: string; label: string; model: string; source: string; analysis: string; signals: string[] }>('/ai/analyze', { scope }) });
export const useApprovalInsight = () =>
  useMutation({ mutationFn: (id?: string) => apiPost<{ found: boolean; id?: string; action?: string; model: string; source?: string; recommendation: string }>('/ai/approval-insight', { id }) });
export const useVaptAnalysis = () =>
  useMutation({ mutationFn: () => apiPost<{ source: string; model: string; count: number; bySeverity: Record<string, number>; analysis: string; note?: string }>('/ai/vapt-analysis', {}) });
export const useRemediation = () =>
  useMutation({ mutationFn: (b: { title?: string; type?: string; provider?: string; resourceName?: string }) => apiPost<{ source: string; model: string; steps: string; note?: string }>('/ai/remediation', b) });
export const useReleaseNotes = () =>
  useMutation({ mutationFn: (b: { files?: { p: string; c: string }[]; version?: string }) => apiPost<{ source: string; model: string; notes: string; note?: string }>('/ai/release-notes', b) });
export const useAutomationSuggest = () =>
  useMutation({ mutationFn: () => apiGet<{ model: string; source: string; suggestions: string; signals: string[] }>('/ai/automation-suggest') });
export const useAgentStatus = () =>
  useQuery({ queryKey: ['ai-agent-status'], queryFn: () => apiGet<{ ok: boolean; engine: string; model: string; crew: boolean; db?: boolean; error?: string }>('/ai/agent-status'), retry: false, refetchInterval: 30000 });
export const useAiChat = () =>
  useMutation({ mutationFn: (message: string) => apiPost<{ answer: string; engine: string; model: string }>('/ai/chat', { message }) });
export const useProvisionStatus = () =>
  useQuery({ queryKey: ['provision-status'], queryFn: () => apiGet<import('./types').ProvisionStatus[]>('/network/provision/status'), retry: false, refetchInterval: 30000 });
export const useTestProvision = () =>
  useMutation({ mutationFn: (provider: string) => apiPost<{ ready: boolean; detail: string }>('/network/provision/test', { provider }) });
export const useVpnStatus = () =>
  useQuery({ queryKey: ['vpn-status'], queryFn: () => apiGet<import('./types').VpnStatus>('/network/vpn/status'), retry: false, refetchInterval: 30000 });
export const useVpnTest = () =>
  useMutation({ mutationFn: ({ host, port }: { host: string; port?: number }) => apiPost<{ reachable: boolean; detail: string }>('/network/vpn/test', { host, port }) });
export const useProvisionSchema = (provider: string, kind: string, region = '', enabled = true) =>
  useQuery({
    queryKey: ['provision-schema', provider, kind, region],
    queryFn: () => apiGet<import('./types').ProvSchema>(`/network/provision/schema?provider=${provider}&kind=${kind}${region ? `&region=${encodeURIComponent(region)}` : ''}`),
    enabled: enabled && !!provider && !!kind,
    staleTime: 60000,
  });
export const useRemediateRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (riskId: string) => apiPost<{ ok: boolean; pending?: boolean; detail: string }>('/network/remediate', { riskId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network'] });
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
};

// ── Users & RBAC ──────────────────────────────────────────────────
export const useUsers = () =>
  useQuery({ queryKey: ['users'], queryFn: () => apiGet<import('./types').User[]>('/users') });

export const useUserRoles = () =>
  useQuery({ queryKey: ['user-roles'], queryFn: () => apiGet<import('./types').RoleSpec[]>('/users/roles') });

const useUserMutation = <T>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
};
export const useCreateUser = () => useUserMutation((b: Record<string, unknown>) => apiPost('/users', b));
export const useUpdateUser = () => useUserMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/users/${id}`, b));
export const useSetUserPassword = () => useUserMutation(({ id, password }: { id: string; password: string }) => apiPost(`/users/${id}/password`, { password }));
export const useDeleteUser = () => useUserMutation((id: string) => apiDelete(`/users/${id}`));

export const useUpdateSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPatch<SettingsData>('/settings', body),
    onSuccess: (data) => { qc.setQueryData(['settings'], data); qc.invalidateQueries({ queryKey: ['provision-status'] }); },
  });
};
/** Toggle maker-checker. DISABLING requires a fresh 2FA code (`code`); enabling can omit it. */
export const useSetMakerChecker = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled: boolean; code?: string }) => apiPost<SettingsData>('/settings/maker-checker', body),
    onSuccess: (data) => { qc.setQueryData(['settings'], data); },
  });
};
/** Upload a branding image (logo / background) — returns its served URL. */
export const useUploadAsset = () =>
  useMutation({ mutationFn: ({ data, mime }: { data: string; mime: string }) => apiPut<{ url: string }>('/settings/asset', { data, mime }) });

// ── Database management (admin) ───────────────────────────────────
export interface LogStoreStatus {
  engine: string; role?: string; ok: boolean; mode?: string; version?: string;
  rows: number; size: string; retentionDays: number; retention: string; sync: string;
  lastTs: string | null; bySource: { source: string; count: number }[]; error?: string; provisioning?: boolean;
}
export interface DbStatus {
  engine: string; ok: boolean; version: string; size: string; sizeBytes: number; uptime: string; error?: string; backupDir: string; backupExternalPath?: string;
  replication: { mode: string; replicas: number; inRecovery: boolean };
  tables: { name: string; rows: number; bytes: number; size: string; isLog: boolean }[];
  logStore?: LogStoreStatus;
}
export interface DbBackup { name: string; bytes: number; at: string; manual: boolean; full?: boolean }
export interface LogHit { ts: string; source: string; level: string; category: string; host: string; actor: string; message: string }
export const useLogSearch = () =>
  useMutation({ mutationFn: (p: { q?: string; source?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (p.q) qs.set('q', p.q);
    if (p.source && p.source !== 'all') qs.set('source', p.source);
    qs.set('limit', String(p.limit ?? 50));
    return apiGet<{ ok: boolean; tookMs: number; rows: LogHit[]; scanned: number; error?: string }>(`/database/logs/search?${qs.toString()}`);
  } });
export const useDbStatus = () => useQuery({ queryKey: ['db-status'], queryFn: () => apiGet<DbStatus>('/database/status'), refetchInterval: 30000, retry: false });
export const useDbBackups = () => useQuery({ queryKey: ['db-backups'], queryFn: () => apiGet<DbBackup[]>('/database/backups'), refetchInterval: 60000, retry: false });
export const useDbBackupNow = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost<{ ok: boolean; name: string; bytes: number; at: string }>('/database/backup'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['db-backups'] }); qc.invalidateQueries({ queryKey: ['db-status'] }); } });
};
// Full system snapshot: built docker images + source code + DB in one archive.
export const useFullSnapshot = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost<{ ok: boolean; name: string; bytes: number; at: string; images: number; source: boolean }>('/database/full-snapshot'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['db-backups'] }); } });
};
export const useFailoverGuide = () =>
  useMutation({ mutationFn: (standbyIp: string) => apiPost<{ primaryIp: string; standbyIp: string; replUser: string; replPassword: string; markdown: string }>('/database/failover-guide', { standbyIp }) });
// Download a backup to the operator's machine (authenticated binary fetch → browser save).
export const useDownloadBackup = () =>
  useMutation({ mutationFn: (name: string) => apiDownload(`/database/backups/${encodeURIComponent(name)}/download`, name) });
export const useSetBackupConfig = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (externalPath: string) => apiPatch('/database/backup-config', { externalPath }), onSuccess: () => qc.invalidateQueries({ queryKey: ['db-status'] }) });
};

// ── HA cluster (1 primary + up to 4 replicas) ──
export interface ClusterNodeStatus {
  id: string; name: string; host: string; role: string; subnet: string | null; reachable: boolean;
  replState: string | null; syncState: string | null; lag: string | null; lagBytes: number | null;
  sshUser: string | null; sshPort: number; hasCreds: boolean;
  deployStatus: 'none' | 'deploying' | 'deployed' | 'failed'; deployStartedAt: string | null; deployLog: string;
  deployProgress: number; syncPaused: boolean;
  lastSyncAt: string | null;
  environment: 'development' | 'test' | 'production';
  lastDeployVersion: string | null; lastDeploySource: string | null; lastDeployAt: string | null;
}
export type EnvRole = 'development' | 'test' | 'production';
export interface DeployRecord { version: string; kind: string; sourceHost: string; targetHost: string; targetName: string; status: string; changes: string; files?: { p: string; c: string }[]; at: string }
export interface ClusterStatus { cname: string; primaryHost: string; envLabel: EnvRole; canOrchestrate: boolean; maxNodes: number; replicasConnected: number; nodes: ClusterNodeStatus[]; build?: string; deploys?: DeployRecord[] }
export const useCluster = () =>
  useQuery({
    queryKey: ['db-cluster'],
    queryFn: () => apiGet<ClusterStatus>('/database/cluster'),
    // Poll fast while any node is mid-deploy (live log), otherwise relax.
    refetchInterval: (q) => ((q.state.data?.nodes ?? []).some((n) => n.deployStatus === 'deploying') ? 4000 : 15000),
    retry: false,
  });
function useClusterMut<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['db-cluster'] }) });
}
export const useAddClusterNode = () => useClusterMut((b: Record<string, unknown>) => apiPost('/database/cluster/nodes', b));
export const useRemoveClusterNode = () => useClusterMut((id: string) => apiDelete(`/database/cluster/nodes/${id}`));
export const useDeployNode = () => useClusterMut((v: { id: string; body?: Record<string, unknown> }) => apiPost(`/database/cluster/nodes/${v.id}/deploy`, v.body ?? {}));
export const useResyncNode = () => useClusterMut((id: string) => apiPost(`/database/cluster/nodes/${id}/resync`, {}));
export const usePromoteExec = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<{ ok: boolean; promoted: string; cname: string; agentsFollow: boolean; message: string }>(`/database/cluster/nodes/${id}/promote`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['db-cluster'] }),
  });
};
export const useSetNodeCreds = () => useClusterMut((v: { id: string; body: Record<string, unknown> }) => apiPatch(`/database/cluster/nodes/${v.id}/creds`, v.body));
export const useSetClusterCname = () => useClusterMut((cname: string) => apiPatch('/database/cluster/cname', { cname }));
export const useSetNodeEnv = () => useClusterMut((v: { id: string; environment: string }) => apiPatch(`/database/cluster/nodes/${v.id}/environment`, { environment: v.environment }));
export const useSetEnvLabel = () => useClusterMut((envLabel: string) => apiPatch('/database/cluster/env-label', { envLabel }));
export const useSetNodeSyncPaused = () => useClusterMut((v: { id: string; paused: boolean }) => apiPatch(`/database/cluster/nodes/${v.id}/sync-paused`, { paused: v.paused }));
export const useSyncToProd = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<{ gated: boolean; requestId?: string; status?: string; message: string }>(`/database/cluster/nodes/${id}/sync-to-prod`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['db-cluster'] }),
  });
};
export const useNodeSetup = () => useMutation({ mutationFn: (id: string) => apiGet<{ markdown: string; primaryIp: string; cname: string; role: string; replPassword: string }>(`/database/cluster/nodes/${id}/setup`) });
export const useNodePromote = () => useMutation({ mutationFn: (id: string) => apiGet<{ markdown: string; node: string; cname: string }>(`/database/cluster/nodes/${id}/promote`) });

// ── Cloud connections (real cloud integration) ────────────────────
export const useConnections = () =>
  useQuery({
    queryKey: ['connections'],
    queryFn: () => apiGet<CloudConnection[]>('/connections'),
    refetchInterval: 20000,
  });

export const useProviderSpecs = () =>
  useQuery({ queryKey: ['provider-specs'], queryFn: () => apiGet<ProviderSpec[]>('/connections/providers') });

// ── Service Catalog (Terraform-engine provisioning) ──
export interface CatalogInput { key: string; label: string; type: 'text' | 'number'; default?: string | number; help?: string }
export interface CatalogTemplateMeta { key: string; name: string; cloud: 'demo' | 'aws' | 'azure' | 'gcp'; description: string; inputs: CatalogInput[] }
export interface ProvisionJob { id: string; template: string; title: string; cloud: string; connectionId?: string | null; status: string; planLog: string; applyLog: string; outputs: Record<string, unknown>; inputs: Record<string, unknown>; estCostMonthly: number; costNote: string; requestedBy: string; approvedBy: string; createdAt: string }
export const useCatalog = () => useQuery({ queryKey: ['catalog'], queryFn: () => apiGet<CatalogTemplateMeta[]>('/catalog') });
export const useProvisionJobs = () => useQuery({ queryKey: ['provision-jobs'], queryFn: () => apiGet<ProvisionJob[]>('/catalog/jobs'), refetchInterval: 6000 });
const useCatalogMut = <T,>(fn: (a: T) => Promise<unknown>) => { const qc = useQueryClient(); return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['provision-jobs'] }) }); };
export const usePlanProvision = () => useCatalogMut((b: { template: string; inputs: Record<string, unknown>; connectionId?: string; title?: string }) => apiPost<ProvisionJob>('/catalog/plan', b));
export const useApplyProvision = () => useCatalogMut((id: string) => apiPost<ProvisionJob>(`/catalog/jobs/${id}/apply`, {}));
export const useDestroyProvision = () => useCatalogMut((id: string) => apiPost(`/catalog/jobs/${id}/destroy`, {}));

export const useCreateConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; provider: string; credentials: Record<string, string> }) =>
      apiPost<{ id: string }>('/connections', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
};

export const useUpdateConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; credentials?: Record<string, string> }) =>
      apiPatch<{ ok: boolean }>(`/connections/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
};

export const useTestConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<TestResult>(`/connections/${id}/test`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
};

export const useSyncConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<{ ok: boolean; discovered: number; account: string }>(`/connections/${id}/sync`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] });
      qc.invalidateQueries({ queryKey: ['resources'] });
      qc.invalidateQueries({ queryKey: ['resource-types'] });
      qc.invalidateQueries({ queryKey: ['management'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
};

export const useDeleteConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/connections/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] });
      qc.invalidateQueries({ queryKey: ['management'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
};

// ── FinOps + Carbon ────────────────────────────────────────────────────────
export const useFinOpsOverview = () =>
  useQuery({ queryKey: ['finops-overview'], queryFn: () => apiGet<import('./types').FinOpsOverview>('/finops/overview'), refetchInterval: 60000 });

export const useCarbonSummary = () =>
  useQuery({ queryKey: ['finops-carbon'], queryFn: () => apiGet<import('./types').CarbonSummary>('/finops/carbon'), refetchInterval: 60000 });

export const useRefreshCost = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost('/management/refresh-cost', {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['finops-overview'] }) });
};

export const useBudgets = () =>
  useQuery({ queryKey: ['finops-budgets'], queryFn: () => apiGet<import('./types').BudgetStatus[]>('/finops/budgets'), refetchInterval: 60000 });

function useBudgetMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finops-budgets'] });
      qc.invalidateQueries({ queryKey: ['finops-overview'] });
    },
  });
}
export const useCreateBudget = () => useBudgetMutation((b: Record<string, unknown>) => apiPost('/finops/budgets', b));
export const useUpdateBudget = () => useBudgetMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/finops/budgets/${id}`, b));
export const useDeleteBudget = () => useBudgetMutation((id: string) => apiDelete(`/finops/budgets/${id}`));

// ── Replication / DR ─────────────────────────────────────────────────────────
export interface ReplicationRun { id: string; direction: string; ok: boolean; durationMs: number; detail: string; startedAt: string; finishedAt: string | null }
export interface ReplicationAgentInfo { host: string; os: string; version: string; online: boolean; lastSeenAt: string | null }
export interface ReplicationSet {
  id: string; name: string; dataType: string; mode: string;
  primaryId: string; primaryName: string; primaryHost: string;
  secondaryId: string; secondaryName: string; secondaryHost: string;
  tertiaryId: string; tertiaryName: string; tertiaryHost: string;
  primaryOs?: string; secondaryOs?: string; tertiaryOs?: string;
  sourcePath: string; targetPath: string; dbEngine: string; dbName: string; dbUser?: string; dockerVolumes: string; driver: string; intervalMin: number; intervalSec: number;
  blockDevice: string; blockDeviceB: string; drbdPort: number; drbdMinor: number; drbdMount: string;
  enabled: boolean; status: string; state: string; lastError: string;
  primaryAgent: ReplicationAgentInfo | null; secondaryAgent: ReplicationAgentInfo | null;
  lagSeconds: number | null; lastRunAt: string | null; lastOkAt: string | null;
  runs: ReplicationRun[];
}
export interface AgentInstaller { scriptUrl: string; oneLiner: string; script: string }
export interface AgentEnroll { host: string; key: string; version: string; linux: AgentInstaller; windows: AgentInstaller }
export const useReplicationSets = () =>
  useQuery({ queryKey: ['replication'], queryFn: () => apiGet<ReplicationSet[]>('/replication'), refetchInterval: 8000 });
const useReplMutation = <T,>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['replication'] }) });
};
export const useCreateReplication = () => useReplMutation((b: Record<string, unknown>) => apiPost('/replication', b));
export const useUpdateReplication = () => useReplMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/replication/${id}`, b));
export const useDeleteReplication = () => useReplMutation((id: string) => apiDelete(`/replication/${id}`));
export const useRunReplication = () => useReplMutation(({ id, direction }: { id: string; direction?: string }) => apiPost(`/replication/${id}/run`, { direction }));
export const usePromoteReplication = () => useReplMutation(({ id, to }: { id: string; to: string }) => apiPost(`/replication/${id}/promote`, { to }));
export const useStopReplication = () => useReplMutation((id: string) => apiPost(`/replication/${id}/stop`, {}));
export interface ReplicationCheck { name: string; target: string; ok: boolean; level: 'error' | 'warn' | 'info'; detail: string }
export interface ReplicationTest { ok: boolean; summary: string; driver: string; checks: ReplicationCheck[] }
export const useTestReplication = () => useMutation({ mutationFn: (id: string) => apiPost<ReplicationTest>(`/replication/${id}/test`, {}) });
export const useEnrollAgent = () => useMutation({ mutationFn: ({ host }: { host: string }) => apiPost<AgentEnroll>('/replication/agent/enroll', { host, baseUrl: typeof window !== 'undefined' ? window.location.origin : '' }) });

export interface VpnLink {
  id: string; name: string; tech: string; manage: string; mode: string; ikeVersion: string; peerType: string;
  aManual: boolean; aId: string; aName: string; aProvider: string; aHost: string; aSubnet: string;
  bManual: boolean; bId: string; bName: string; bProvider: string; bDevice: string; bHost: string; bSubnet: string;
  status: string; lastError: string; lastStatus: string; lastCheckAt: string | null; enabled: boolean; hasPsk: boolean;
  vpnConnId: string; statusSource: string; monitorHost: string; monitorTarget: string; monitorPorts: string;
  monitorUp: boolean; monitorResult: string; lastMonitorAt: string | null;
}
export interface VpnEligibleHost { id: string; name: string; provider: string; os: string; host: string; credHost: string; hasCred: boolean }
export interface VpnGatewayType { key: string; label: string; cloud: boolean }
export interface VpnRequirements {
  aProvider: string; bProvider: string; peerType: string; profileLabel: string;
  aHost: string; bHost: string; aSubnet: string; bSubnet: string;
  ike: string; esp: string; ports: string[]; aReqs: string[]; bReqs: string[]; peerReqs: string[]; mirror: string[];
}
export const useVpnLinks = () => useQuery({ queryKey: ['vpn'], queryFn: () => apiGet<VpnLink[]>('/vpn'), refetchInterval: 10000 });
export const useVpnGatewayTypes = () => useQuery({ queryKey: ['vpn-gw-types'], queryFn: () => apiGet<VpnGatewayType[]>('/vpn/gateway-types'), staleTime: 300000 });
export const useVpnEligibleHosts = () => useQuery({ queryKey: ['vpn-eligible'], queryFn: () => apiGet<VpnEligibleHost[]>('/vpn/eligible-hosts'), staleTime: 30000 });
export const useVpnRequirements = () => useMutation({ mutationFn: (b: Record<string, unknown>) => apiPost<VpnRequirements>('/vpn/requirements', b) });
const useVpnMutation = <T,>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['vpn'] }) });
};
export const useCreateVpn = () => useVpnMutation((b: Record<string, unknown>) => apiPost('/vpn', b));
export const useDeleteVpn = () => useVpnMutation((id: string) => apiDelete(`/vpn/${id}`));
export const useVpnUp = () => useVpnMutation((id: string) => apiPost(`/vpn/${id}/up`, {}));
export const useVpnDown = () => useVpnMutation((id: string) => apiPost(`/vpn/${id}/down`, {}));
export const useVpnLinkStatus = () => useVpnMutation((id: string) => apiPost(`/vpn/${id}/status`, {}));
export const useVpnMonitor = () => useVpnMutation((id: string) => apiPost(`/vpn/${id}/monitor`, {}));

export interface FabricStep { stage: string; status: string; detail: string }
export interface NetworkFabric {
  id: string; name: string; status: string; armed: boolean; stage: string;
  aProvider: string; aRegion: string; aCidr: string; aSubnetCidr: string; aNetworkId: string; aGatewayId: string; aGatewayIp: string; aConnId: string;
  bProvider: string; bRegion: string; bCidr: string; bSubnetCidr: string; bNetworkId: string; bGatewayId: string; bGatewayIp: string; bConnId: string;
  vpnLinkId: string; steps: FabricStep[]; lastError: string; createdAt: string | null;
}
export const useFabrics = () => useQuery({ queryKey: ['fabric'], queryFn: () => apiGet<NetworkFabric[]>('/fabric'), refetchInterval: 8000 });
const useFabricMutation = <T,>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric'] }) });
};
export const useCreateFabric = () => useFabricMutation((b: Record<string, unknown>) => apiPost('/fabric', b));
export const useUpdateFabric = () => useFabricMutation(({ id, ...b }: { id: string } & Record<string, unknown>) => apiPatch(`/fabric/${id}`, b));
export const useArmFabric = () => useFabricMutation((id: string) => apiPost(`/fabric/${id}/arm`, {}));
export const useRetryFabric = () => useFabricMutation((id: string) => apiPost(`/fabric/${id}/retry`, {}));
export const useDeprovisionFabric = () => useFabricMutation((id: string) => apiPost(`/fabric/${id}/deprovision`, {}));
export const useDeleteFabric = () => useFabricMutation((id: string) => apiDelete(`/fabric/${id}`));

// ── AIOps anomaly detection (AI Engine → Anomalies tab) ───────────────────
export const useAnomalies = (filter?: { detector?: string; status?: string }) => {
  const params = new URLSearchParams();
  if (filter?.detector) params.set('detector', filter.detector);
  if (filter?.status) params.set('status', filter.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['aiops-anomalies', filter?.detector ?? 'all', filter?.status ?? 'all'],
    queryFn: () => apiGet<import('./types').AnomalyDetectionRow[]>(`/aiops/anomalies${qs ? `?${qs}` : ''}`),
    refetchInterval: 30000,
  });
};

/** Confirm/dismiss a detection — the human label that gates external notifications. */
export const useReviewAnomaly = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, verdict }: { id: string; verdict: 'confirm' | 'dismiss' }) => apiPost(`/aiops/anomalies/${id}/${verdict}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['aiops-anomalies'] });
      qc.invalidateQueries({ queryKey: ['aiops-quality'] });
    },
  });
};

export const useAnomalyQuality = () =>
  useQuery({ queryKey: ['aiops-quality'], queryFn: () => apiGet<import('./types').AnomalyQuality>('/aiops/quality'), refetchInterval: 60000 });

export const useRunAnomalyScan = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiPost('/aiops/scan', {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['aiops-anomalies'] }) });
};

export const useRunEvalTrial = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params?: { seed?: number; trials?: number; resourceTypes?: string[]; sweep?: boolean }) =>
      apiPost<import('./types').AnomalyTrialReport>('/aiops/eval/run', params ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['aiops-quality'] });
      qc.invalidateQueries({ queryKey: ['aiops-validation'] });
    },
  });
};

// ── Validation suite (thesis evidence: RCA top-k, correlation, CIEM, summary) ──
export const useValidationSummary = () =>
  useQuery({ queryKey: ['aiops-validation'], queryFn: () => apiGet<import('./types').ValidationSummary>('/aiops/validation'), refetchInterval: 60000 });

const useValidationMutation = <T,>(fn: (v: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['aiops-validation'] }) });
};
export const useRunRcaEval = () => useValidationMutation(() => apiPost('/aiops/eval/rca', {}));
export const useRunCorrelationEval = () => useValidationMutation(() => apiPost('/aiops/eval/correlation', {}));
export const useRunCiemEval = () => useValidationMutation(() => apiPost('/ciem/eval/run', {}));
export const useCorrelations = () =>
  useQuery({ queryKey: ['aiops-correlations'], queryFn: () => apiGet<{ groups: import('./types').CorrelationGroup[]; scanned: number }>('/aiops/correlations'), refetchInterval: 60000 });

export const useSuppressions = () =>
  useQuery({ queryKey: ['aiops-suppressions'], queryFn: () => apiGet<import('./types').SuppressionWindowCfg[]>('/aiops/suppressions') });
export const useSaveSuppressions = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (windows: import('./types').SuppressionWindowCfg[]) => apiPut('/aiops/suppressions', windows),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['aiops-suppressions'] }),
  });
};
