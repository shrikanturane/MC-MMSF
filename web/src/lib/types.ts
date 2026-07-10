import type { Provider, Severity } from './format';

export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  name: string;
  email: string;
  contact: string;
  role: Role;
  status: string; // active | suspended
  monitorGroups?: string[]; // monitor groups this user may see ([] / undefined = all)
  twoFactorEnabled?: boolean;
  require2fa?: boolean; // admin-set MFA requirement
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleSpec {
  role: Role;
  label: string;
  description: string;
  permissions: string[];
}

export interface AuditEntry {
  id: string;
  ts: string;
  action: string;
  actorEmail: string;
  targetEmail: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  category: string;
  scopeEnv: string;
  ruleKind: string;
  ruleConfig: Record<string, unknown>;
  effect: string;
  enabled: boolean;
  lastEvalAt: string | null;
  checkedCount: number;
  violationCount: number;
}

export interface PolicyViolation {
  id: string;
  policyId: string;
  resourceId: string;
  resourceName: string;
  provider: Provider;
  environment: string;
  detail: string | null;
  ts: string;
}

export interface EnvironmentSummary {
  environments: { env: string; resources: number; violations: number }[];
  totals: { resources: number; policies: number; enabledPolicies: number; violations: number; compliancePct: number };
}

export interface ReportSource {
  key: string;
  label: string;
  columns: string[];
  filters: string[];
}

export interface ReportItem {
  id: string;
  name: string;
  description: string;
  source: string;
  config: Record<string, unknown>;
  format: string;
  schedule: string;
  recipients: string;
  lastRunAt: string | null;
  lastRowCount: number;
}

export interface ReportRun {
  id: string;
  reportId: string;
  ts: string;
  status: string;
  rowCount: number;
  trigger: string;
  detail: string | null;
}

export interface ApprovalRequest {
  id: string;
  action: string;
  title: string;
  resourceName: string | null;
  status: string;
  requestedByEmail: string;
  mine?: boolean;
  approverEmail: string | null;
  result: string | null;
  phase?: string | null;
  remediation?: string | null;
  retries?: number;
  retryable?: boolean;
  payload?: Record<string, any>;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export interface ApprovalPolicy {
  id: string;
  action: string;
  label: string;
  requiresApproval: boolean;
  autoApproveAdmin: boolean;
}

export interface ActivityEvent {
  id: string;
  ts: string;
  type: string;
  severity: string;
  title: string;
  detail: string | null;
  resourceName: string | null;
  provider: string | null;
}

export interface ActivitySummary {
  total: number;
  last24h: number;
  byType: { type: string; count: number }[];
  bySeverity: { severity: string; count: number }[];
}

export interface SiemEventItem {
  id: string;
  ts: string;
  source: string;
  host: string | null;
  level: string;
  category: string;
  message: string;
}

export interface AuditItem {
  id: string;
  ts: string;
  action: string;
  actorEmail: string;
  targetEmail: string | null;
  ip: string | null;
  detail: string | null;
}

export interface PredictivePrediction {
  metric: string;
  label: string;
  unit: string;
  current: number;
  trend: 'rising' | 'falling' | 'flat';
  slopePerHr: number;
  threshold: number;
  eta: string | null;
  willBreach: boolean;
  severity: 'critical' | 'high' | 'warning' | 'info';
  anomaly: boolean;
}

export interface PredictiveData {
  generatedAt: string;
  dataPoints: number;
  kpis: { riskScore: number; activeAlerts: number; forecastNextHour: number; atRisk: number; anomalies: number; forecastBreaches: number };
  predictions: PredictivePrediction[];
  atRisk: { id: string; name: string; provider: string; cpu: number; memory: number; disk: number; worst: number; which: string }[];
  resourceForecasts: { id: string; name: string; provider: string; metric: string; current: number; threshold: number; slopePerHr: number; eta: string; etaMin: number }[];
  series: { ts: string; cpu: number; memory: number; disk: number; latencyMs: number; errorRate: number }[];
}

export interface GroupAccess { governs: boolean; all: boolean; modules: string[]; widgets: string[]; help: string[]; pages: string[] }
export interface GroupItem {
  id: string;
  name: string;
  description: string;
  notifyVia: string; // email | whatsapp | both
  access: GroupAccess; // permission-based access policy (governs ? restricts members : notification-only)
  memberCount: number;
  members: { id: string; name: string; email: string; contact: string }[];
}

export interface IntegrationField {
  key: string;
  label: string;
  group: string; // sso | email | whatsapp
  provider: string; // google | microsoft | email | whatsapp | sso-common
  secret: boolean;
  hint: string;
  set: boolean;
  value: string;
}

export interface DeliveryItem {
  id: string;
  ts: string;
  channelName: string;
  channelType: string;
  target: string;
  subject: string;
  status: string; // sent | failed | retrying | gave_up
  error: string | null;
  attempts: number;
  nextRetryAt: string | null;
  canRetry: boolean;
}

export interface ResourceTimeline {
  resourceName: string;
  events: { id: string; ts: string; type: string; severity: string; title: string; detail: string | null }[];
  alerts: { id: string; title: string; severity: Severity; status: string; raisedAt: string; resolvedAt: string | null }[];
}

export interface NetworkOverview {
  exposure: { name: string; provider: Provider; type: string; region: string; publicIp: string; environment: string }[];
  inventory: { provider: Provider; kind: string; count: number }[];
  segments: { provider: Provider; group: string; count: number }[];
  risks: { id: string; provider: Provider; resourceName: string; ruleName: string; source: string; ports: string; protocol: string; severity: Severity; detail: string }[];
  summary: { exposed: number; networkResources: number; risks: number; bySeverity: { critical: number; high: number; medium: number; low: number } };
}

export interface TopoVm {
  id: string;
  name: string;
  status: string;
  up: boolean;
  provider?: string;
  region?: string;
  publicIp: string | null;
  privateIp: string | null;
  controllable: boolean;
  os?: string | null;
  size?: string | null;
  cpuPct?: number;
  memoryPct?: number;
  diskPct?: number;
}
export interface TopoNet {
  id: string;
  name: string;
  region: string;
  vnet: string | null;
  nsgs: string[];
  resourceCount: number;
  openPorts: { resourceName: string; ports: string; source: string; protocol: string; severity: string }[];
  vms: TopoVm[];
}
export interface TopoProvider {
  provider: Provider;
  status: string;
  vmCount: number;
  upCount: number;
  hasVpn: boolean;
  vpnGateways: { name: string }[];
  networks: TopoNet[];
}
export interface TopologyData {
  app: { name: string; host: string };
  providers: TopoProvider[];
  vpnPairs: { a: string; b: string; status: string }[];
  generatedAt: string;
}

export interface NetworkMonitoringData {
  connectivity: { total: number; up: number; down: number; unknown: number; uptimePct: number };
  fleetAvgLatency: number | null;
  totalMbps: number;
  latencies: {
    id: string;
    name: string;
    target: string;
    type: string;
    group: string;
    status: string;
    lastLatencyMs: number | null;
    avgLatencyMs: number | null;
    history: { up: boolean; ms: number | null }[];
  }[];
  throughput: { name: string; provider: Provider; networkMbps: number }[];
}

export interface ManagementOverview {
  kpis: {
    totalAccounts: number;
    activeRegions: number;
    totalResources: number;
    privateCloudNodes: number;
    monthlyBill: number;
  };
  distribution: { provider: Provider; total: number; byType: Record<string, number> }[];
  costAllocation: { service: string; cost: number }[];
  governance: { provider: Provider; score: number; accounts: number }[];
}

export interface ManagementSummary {
  currency: string;
  kpis: {
    totalAssets: number;
    runningResources: number;
    cloudAccounts: number;
    securityAlerts: number;
    complianceScore: number;
    monthlyCost: number;
  };
  cloudDistribution: { provider: Provider; count: number; pct: number }[];
  costDistribution: { provider: Provider; cost: number }[];
  securityOverview: { critical: number; high: number; medium: number; low: number };
  complianceOverview: { name: string; score: number; source: string }[];
  complianceSource: string;
  topCostDrivers: { name: string; cost: number }[];
  recentIncidents: { title: string; severity: Severity; resourceName: string | null; ts: string }[];
}

export interface CloudAccount {
  id: string;
  name: string;
  provider: Provider;
  accountRef: string;
  region: string;
  status: string;
  resources: number;
  monthlyCost: number;
}

export interface MonitoringOverview {
  kpis: {
    avgCpu: number;
    avgMemory: number;
    avgDisk: number;
    diskHasData: boolean;
    memoryHasData: boolean;
    networkMbps: number;
    latency: number | null;
    errorRate: number;
  };
  serviceHealth: { provider: Provider; service: string; total: number; health: string }[];
  topConsumers: {
    cpu: { id: string; name: string; provider: Provider; value: number }[];
    memory: { id: string; name: string; provider: Provider; value: number }[];
  };
}

export interface VmTelemetry {
  id: string;
  name: string;
  provider: Provider;
  region: string;
  status: string;
  cpuPct: number;
  memoryPct: number;
  diskPct: number | null;
  networkMbps: number | null;
}

export interface SystemEvent {
  id: string;
  ts: string;
  type: string;
  severity: string;
  title: string;
  detail: string | null;
  resourceName: string | null;
  provider: Provider | null;
}

export interface TimePoint {
  ts: string;
  value: number;
}

export interface Incident {
  id: string;
  title: string;
  severity: Severity;
  status: string;
  provider: Provider;
  resourceName: string | null;
  openedAt: string;
}

export interface SecurityOverview {
  kpis: {
    openVulnerabilities: number;
    misconfigurations: number;
    threatDetections: number;
    vulnBreakdown: Record<Severity, number>;
  };
  findingsByProvider: ({ provider: Provider; total: number } & Record<Severity, number>)[];
  frameworks: { name: string; score: number; passed: number; total: number }[];
  recentThreats: {
    id: string;
    title: string;
    severity: Severity;
    provider: Provider;
    resourceName: string;
    detectedAt: string;
  }[];
  topExposed: {
    name: string;
    type: string;
    provider: Provider;
    findings: number;
    severity: Severity;
  }[];
}

export interface ResourceTypes {
  total: number;
  types: { type: string; count: number }[];
}

export interface ResourceRow {
  id: string;
  name: string;
  externalId: string;
  provider: Provider;
  type: string;
  service: string;
  region: string;
  status: string;
  cpuPct: number;
  memoryPct: number;
  diskPct: number;
  diskUsedMB: number | null;
  memUsedMB: number | null;
  monthlyCost: number;
  account: string | null;
}

export interface Dataset {
  key: string;
  label: string;
  kind: 'category' | 'series' | 'stat';
  data?: { label: string; value: number }[];
  series?: { ts: string; value: number }[];
  value?: number;
  unit?: string;
}

export interface DashWidget {
  id: string;
  title: string;
  dataset: string;
  chart: string;
  width: number; // 1=third, 2=half, 3=full
}

// Draggable/resizable board panel.
export interface BoardPanel {
  i: string; // id
  kind: string; // kpis | trend | alerts | telemetry | health | events | ipmon | chart
  title?: string;
  cfg?: Record<string, any>;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ComplianceItem {
  id: string;
  standard: string;
  control: string;
  description: string | null;
  status: string; // passed | failed | na
  source: string; // manual | defender
}

export interface ZeroTrustPosture {
  score: number;
  maturity: string;
  principle: string;
  prodResources: number;
  generatedAt: string;
  pillars: { key: string; name: string; icon: string; score: number; checks: { label: string; status: 'ok' | 'warn' | 'fail'; detail: string }[]; recommendations: string[] }[];
  recommendations: { pillar: string; text: string; action: { kind: 'remediate' | 'link'; to?: string; label: string } }[];
}

export interface ZtWorkloadVm {
  id: string;
  name: string;
  provider: string;
  os: string | null;
  covered: boolean;
  mode: string | null;
  lastSeenAt: string | null;
  vulnerabilities: number;
  publicIp: string | null;
}
export interface ZtWorkloads {
  total: number;
  covered: number;
  uncovered: number;
  withVulns: number;
  vms: ZtWorkloadVm[];
}

export interface VpnRule { direction: string; protocol: string; port: string; purpose: string }
export interface VpnScript { provider: string; shell: string; script: string }
export interface VpnPair {
  a: string;
  b: string;
  deployed: boolean;
  aHasGateway: boolean;
  bHasGateway: boolean;
  psk: string;
  rules: VpnRule[];
  scripts: VpnScript[];
}
export interface VpnStatus { pairs: VpnPair[]; generatedAt: string }

export interface ProvisionStatus {
  provider: string;
  connectionId: string;
  connectionName: string;
  status: string;
  lastSyncAt: string | null;
  assetsFound: number;
  execEnabled: boolean;
}

export interface GrantScript {
  provider: string;
  connectionName: string;
  masked?: boolean;
  shell: string;
  script: string;
  ready: boolean;
  missing: string[];
  loginUrl: string | null;
  loginLabel: string;
  autoRun: boolean;
}

export interface ProvOption { value: string; label: string }
export interface ProvField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'password' | 'note';
  required?: boolean;
  options?: ProvOption[];
  allowNew?: boolean;
  newLabel?: string;
  default?: string;
  placeholder?: string;
  help?: string;
  pattern?: string;
  patternHint?: string;
}
export interface ProvSchema {
  provider: string;
  kind: string;
  title: string;
  executable: boolean;
  fields: ProvField[];
}

export interface MonitorItem {
  id: string;
  name: string;
  target: string;
  altTargets?: string; // comma-separated alternate IPs for the same device
  type: string;
  port: number | null;
  group: string;
  enabled: boolean;
  status: string; // up | down | unknown
  lastAddress?: string | null; // which IP last answered
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  history?: { ts: string; up: boolean; ms: number | null }[];
  // Network-device (firewall/router/switch) SNMP telemetry.
  deviceKind?: string;
  snmpCommunity?: string;
  jitterMs?: number | null;
  uptimeSec?: number | null;
  interfaces?: { index: number; name: string; status: string; speedMbps: number; inBps: number; outBps: number; utilPct: number; mac?: string }[];
  neighbors?: { mac: string; ip?: string; ifName?: string }[];
}

export interface NetDevIface { index: number; name: string; status: string; speedMbps: number; inBps: number; outBps: number; utilPct: number; mac?: string }
export interface NetDevTalker { name: string; bps: number; inBps: number; outBps: number; utilPct: number }
export interface NetworkDevice {
  id: string;
  name: string;
  target: string;
  group: string;
  deviceKind: string;
  status: string;
  snmp: boolean;
  snmpStatus: string; // ok | stale | no-response | off
  latencyMs: number | null;
  jitterMs: number | null;
  uptimeSec: number | null;
  deviceMac: string | null;
  ifTotal: number;
  ifUp: number;
  linkDown: number;
  connectedCount: number;
  maxUtilPct: number;
  totalInBps: number;
  totalOutBps: number;
  topTalkers: NetDevTalker[];
  interfaces: NetDevIface[];
  neighbors: { mac: string; ip?: string; ifName?: string }[];
  lastCheckedAt: string | null;
  lastSnmpAt: string | null;
}

export interface AlertRule {
  id: string;
  name: string;
  kind?: string; // threshold | event
  metric: string;
  comparator: string;
  threshold: number;
  event?: string | null; // vm_power_off | vm_power_on | device_unreachable | agent_offline
  severity: Severity;
  scopeProvider: string | null;
  scopeEnv?: string | null;
  notify?: string[]; // ["popup","email","whatsapp"]
  notifyEmail?: string | null;
  notifyPhone?: string | null;
  enabled: boolean;
}

export interface AlertItem {
  id: string;
  title: string;
  severity: Severity;
  source: string;
  status: string;
  metric: string | null;
  value: number | null;
  resourceName: string | null;
  escalated: boolean;
  raisedAt: string;
  resolvedAt: string | null;
}

export interface Workflow {
  id: string;
  name: string;
  trigger: string;
  status: string;
  runs: number;
  lastRun: string | null;
  triggerKind: string;
  triggerValue: string | null;
  actionType: string;
  actionConfig: Record<string, unknown> | null;
  conditions?: { field: string; op: string; value: string }[];
  steps?: { type: string; config?: Record<string, unknown> }[];
  escalation?: { afterMinutes: number; steps: { type: string; config?: Record<string, unknown> }[] }[];
}

export interface EscalationPolicy {
  id: string;
  name: string;
  afterMinutes: number;
  severity: Severity;
  actionType: string;
  target: string | null;
  enabled: boolean;
}

export interface AlertingOverview {
  kpis: {
    activeAlerts: number;
    critical: number;
    high: number;
    escalated: number;
    rules: number;
    workflows: number;
    escalations: number;
  };
}

export interface ResourceDetailData {
  resource: ResourceRow & {
    source: string;
    properties: Record<string, unknown>;
    lastSeenAt: string | null;
  };
  metrics: {
    available: boolean;
    cpu?: TimePoint[];
    networkMbps?: TimePoint[];
    diskKBps?: TimePoint[];
    memoryAvailGB?: TimePoint[] | null;
    latest?: {
      cpuPct: number | null;
      networkMbps: number | null;
      diskKBps: number | null;
      memoryAvailGB: number | null;
    };
    note?: string;
  };
}

export interface VmConnect {
  ip: string | null;
  rdp: { ip: string; port: number } | null;
  ssh: { ip: string; port: number; cmd: string } | null;
  telnet: { ip: string; port: number; cmd: string } | null;
  docker: { id: string; cmd: string } | null;
}

export interface VmRow {
  id: string;
  name: string;
  provider: Provider;
  account: string | null;
  region: string;
  status: string;
  os: string;
  size: string | null;
  cpuPct: number;
  publicIp: string | null;
  privateIp: string | null;
  controllable: boolean;
  connect: VmConnect;
}

export interface CommandCenterOverview {
  kpis: {
    totalResources: number;
    activeAlerts: number;
    criticalAlerts: number;
    activeIncidents: number;
    avgCpu: number;
    avgMemory: number;
    networkGbps: number;
  };
  alerts: { id: string; title: string; severity: Severity; source: string; status: string; raisedAt: string }[];
  incidents: Incident[];
  aiEngine: {
    status: string;
    model: string;
    anomaliesDetected: number;
    anomalies: { resource: string; provider: string; metric: string; value: number; note: string }[];
    forecast: { metric: string; current: number; predicted: number; trend: string; horizon: string } | null;
    confidence: number;
    insight: string;
  };
  workflows: { id: string; name: string; trigger: string; status: string; runs: number; lastRun: string | null }[];
  topConsumers: { id: string; name: string; provider: Provider; cpu: number; memory: number }[];
  agents: { id: string; name: string; displayName?: string | null; machineName?: string | null; hostname: string | null; altHosts?: string; os: string | null; group?: string; outbound?: boolean; version?: string | null; currentVersion?: string | null; outdated?: boolean; cpuPct: number | null; memPct: number | null; diskPct: number | null; netMbps: number | null; services: number; loggedInUser?: string | null; posture?: Record<string, unknown> | null; active: boolean; mode: string; port?: number; intervalSec: number; lastSeenAt: string | null; online: boolean }[];
  siem: {
    counts: Record<string, number>;
    events: { id: string; ts: string; source: string; host: string | null; level: string; category: string; message: string }[];
  };
}

export interface CloudConnection {
  id: string;
  name: string;
  provider: Provider;
  accountRef: string;
  status: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  assetsFound: number;
  createdAt: string;
  monthlyCost?: number;
  currency?: string;
  costNote?: string;
  costRefreshedAt?: string | null;
}

export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  multiline?: boolean;
}

export interface ProviderSpec {
  provider: Provider;
  fields: ProviderField[];
}

export interface TestStage {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
  optional?: boolean;
}

export interface TestResult {
  ok: boolean;
  stages: TestStage[];
  detail: string;
}

export interface SettingsData {
  profile: { userName: string; userEmail: string; userRole: string; orgName: string };
  region: { timezone: string; dateFormat: string; currency: string; language: string };
  branding: { orgName: string; primaryColor: string; tagline?: string; theme?: string; logo?: string; bgImage?: string; fontScale?: string; fontFamily?: string; reduceMotion?: boolean; highContrast?: boolean; solidSurfaces?: boolean };
  modules: Record<string, boolean>;
  layout?: import('./modules').LayoutConfig;
  logRetentionDays?: number;
  provisioningEnabled?: boolean;
  makerChecker?: boolean;
  systemParams?: {
    monitorIntervalSec: number; alertEvalSec: number; agentOfflineSec: number;
    agentRetentionDays: number; approvalExpiryDays: number; logTtlSettingDays: number;
    sessionTimeoutHours: number;
  };
  connections: { provider: Provider; accounts: number; status: string }[];
  integrations: { id: string; name: string; kind: string; target: string; status: string }[];
}

// ── FinOps + Carbon (GreenOps) ─────────────────────────────────────────────
export interface Breakdown { key: string; value: number; pct: number }
export interface CarbonBreakdown { key: string; kg: number; kwh: number; pct: number }

export interface BudgetStatus {
  id: string; name: string; scope: string; scopeValue: string; amount: number;
  period: string; actual: number; usedPct: number; projected: number;
  status: 'ok' | 'warning' | 'over'; pace: number;
}

export interface CostResourceRow {
  name: string;
  provider: string;
  service: string;
  region: string;
  type: string;
  environment: string;
  account: string;
  status: string;
  cost: number;
}

export interface FinOpsOverview {
  currency: string;
  totalMonthly: number;
  annualRunRate: number;
  projectedMonthEnd: number;
  deltaVsPrevPct: number;
  resourceCount: number;
  unitCost: number;
  realBilling: boolean;
  potentialSavings: number;
  byProvider: Breakdown[];
  byService: Breakdown[];
  byEnvironment: Breakdown[];
  byRegion: Breakdown[];
  byType: Breakdown[];
  byAccount: Breakdown[];
  topDrivers: { name: string; provider: string; service: string; region: string; environment: string; status: string; cpuPct: number; monthlyCost: number }[];
  resources: CostResourceRow[];
  savings: { id: string; title: string; category: string; resourceName: string; provider: string; monthlySaving: number; detail: string }[];
  anomalies: { label: string; type: string; cost: number; z: number; note: string }[];
  forecast: { month: string; value: number; kind: 'actual' | 'forecast' }[];
  budgets: BudgetStatus[];
  byCurrency?: { currency: string; amount: number }[];
  currencyMixed?: boolean;
  costStatus?: { provider: string; name: string; monthlyCost: number; currency: string; note: string; state: 'ok' | 'zero' | 'setup'; refreshedAt: string | null }[];
}

export interface CarbonSummary {
  totalKgMonth: number;
  tonnesMonth: number;
  tonnesYear: number;
  totalKWhMonth: number;
  annualMWh: number;
  weightedIntensity: number;
  carbonPerDollar: number;
  carbonPerResource: number;
  resourceCount: number;
  equivalents: { treeSeedlings: number; passengerCars: number; homesPowered: number; flightsLondonNY: number };
  byProvider: CarbonBreakdown[];
  byRegion: CarbonBreakdown[];
  byEnvironment: CarbonBreakdown[];
  byType: CarbonBreakdown[];
  intensityBoard: { region: string; gco2: number; kg: number; workloads: number }[];
  renewable: { provider: string; key: string; renewablePct: number; pue: number }[];
  recommendations: { title: string; category: string; detail: string; savingKgMonth: number }[];
  trend: { month: string; kg: number }[];
  methodology: string;
}

// OS inventory drill-down (Management widget): OS type → version → host → detail.
export interface OsHost {
  id: string;
  name: string;
  provider?: string | null;
  status?: string;
  hasAgent?: boolean;
  ips: string[];
  up: boolean;
  lastSeenAt: string | null;
  osVersion: string | null;
  appsSource: 'installed' | 'running';
  apps: string[];
  ports: { port: number; proc?: string }[];
  connections: { raddr?: string; rport?: number; lport?: number; proc?: string; state?: string }[];
}
export interface OsVersionGroup { version: string; support?: 'eol' | 'ok' | 'unknown'; total: number; up: number; down: number; hosts: OsHost[] }
export interface OsFamilyGroup { family: string; label: string; total: number; up: number; down: number; withAgent?: number; versions: OsVersionGroup[] }
export interface OsInventory { families: OsFamilyGroup[]; totalHosts: number; withAgent?: number; updatedAt: string }

// ── AIOps anomaly detection (AI Engine → Anomalies tab) ───────────────────
export interface AnomalyDetectionRow {
  id: string;
  resourceId: string;
  resourceName: string;
  provider: string;
  detectorType: 'cost' | 'behaviour' | 'threshold';
  metric: string;
  score: number;
  baseline: 'self' | 'cohort' | 'rule';
  threshold: number;
  value: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
  isConfirmed: boolean | null; // null = unreviewed, true = confirmed, false = dismissed (FP)
  confirmedBy: string | null;
  alertId: string | null;
  source: string;
  detectedAt: string;
}

export interface AnomalyQuality {
  live: {
    confirmed: number;
    dismissed: number;
    unreviewed: number;
    reviewed: number;
    precision: number | null;
    fpShare: number | null;
    byDetector: Record<string, number>;
    note: string;
  };
  eval: {
    precision: number | null;
    recall: number | null;
    fpRate: number | null;
    mttdSeconds: number | null;
    ranAt: string;
    note: string;
  } | null;
}

export interface AnomalyTrialCase {
  resourceId: string;
  resourceName: string;
  label: 'normal' | 'anomalous';
  flagged: boolean;
  outcome: 'TP' | 'FP' | 'TN' | 'FN';
  detectSeconds: number | null;
  detail: string;
}

export interface AnomalyTrialReport {
  precision: number | null;
  recall: number | null;
  fpRate: number | null;
  mttdSeconds: number | null;
  counts: { tp: number; fp: number; tn: number; fn: number };
  cases: AnomalyTrialCase[];
  seed: number;
  chUsed: boolean;
  pilotCase: string;
}

// ── Validation suite (thesis evidence) ─────────────────────────────────────
export interface SuppressionWindowCfg {
  id: string;
  name: string;
  match: string; // resource-name substring ('' = all)
  metric: string; // '' = all metrics
  days: number[]; // UTC DOW 0-6, [] = every day
  startHour: number;
  endHour: number;
  enabled: boolean;
}

export interface CorrelationGroup {
  key: string;
  metric: string;
  providers: string[];
  crossCloud: boolean;
  alertIds: string[];
  resources: string[];
  startedAt: string;
  spanMs: number;
}

export interface ValidationTestRow {
  id: string;
  name: string;
  status: 'evidence' | 'ready' | 'manual';
  metric: unknown;
}

export interface ValidationSummary {
  anomaly: (AnomalyTrialReport & { ranAt?: string; aggregate?: Record<string, { mean: number; sd: number; n: number } | null>; mttdByType?: Record<string, number | null>; suppressionCase?: string; prCurve?: { threshold: number; precision: number | null; recall: number | null; fpRate: number | null }[]; trials?: number }) | null;
  rca: { ranAt: string; incidents: number; topK: { k1: number; k3: number; k5: number }; precisionAt1: number; falseCauseRate: number; meanDiagnosisMs: number; cases: { host: string; provider: string; truth: string; top1: string | null; rankOfTruth: number | null; ms: number }[] } | null;
  correlation: { ranAt: string; recall: number; precision: number | null; verdict: string; providersLinked: string[] } | null;
  ciem: { ranAt: string; identities: number; planted: number; precision: number | null; recall: number | null; verdict: string; consistency: { multiCloudIdentities: number; consistent: number; consistencyPct: number | null } } | null;
  quality: AnomalyQuality;
  suppressions: SuppressionWindowCfg[];
  inventoryLatency: { count: number; meanSec: number | null; medianSec: number | null; note: string };
  map: ValidationTestRow[];
}
