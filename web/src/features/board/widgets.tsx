'use client';

import { useState, type ReactNode } from 'react';
import { AreaTrend, CategoryBar, CategoryPie } from '@/components/charts';
import { IpMonitorPanel } from '@/features/monitors/IpMonitorPanel';
import { NetworkDevicesPanel } from '@/features/monitors/NetworkDevicesPanel';
import { ComplianceDetail } from '@/features/compliance/ComplianceDetail';
import { VmsTable } from '@/features/vms/VmsTable';
import { RulesManager } from '@/features/management/RulesManager';
import { ZeroTrustPosture } from '@/features/security/ZeroTrustPosture';
import { FindingsPanel, AutomationPanel, DeliveryChannelsPanel, RulesPanel } from '@/features/security/panels';
import { EnvironmentsPanel, PoliciesPanel } from '@/features/governance/panels';
import { FirewallRisksPanel, PublicExposurePanel, NetworkInventoryPanel, NetworkSegmentsPanel, LinkHealthPanel, NetworkThroughputPanel } from '@/features/network/panels';
import { CostTrendPanel, CostBreakdownsPanel, CostDriversPanel, CostOptimizationPanel, BudgetsPanel, CarbonEquivalentsPanel, CarbonTrendPanel, CarbonBreakdownsPanel, CarbonGridPanel, CarbonRecommendationsPanel } from '@/features/finops/panels';
import { SiemStreamPanel, AuditTrailPanel } from '@/features/activity/panels';
import { AnomalyFeedPanel, AnomalyQualityCard } from '@/features/ai/anomalies';
import { ValidationPanel } from '@/features/ai/validation';
import { OsInventoryWidget } from './OsInventoryWidget';
import { ProgressBar, Modal } from '@/components/ui';
import { CostDrillDown } from '@/features/finops/CostDrillDown';
import { useAckAlert, useAgents, useAlerts, useApprovals, useDatasets, useIncidents, useManagementSummary, useMonitoring, useResolveAlert, useRetryRequest, useSystemEvents, useTelemetry, useTimeseries, useVms, useMonitors, useCommandCenter, useZeroTrust, useActivityPredictive, useUpdateAgent, useFinOpsOverview } from '@/lib/hooks';
import { WidgetLabel } from './WidgetLabel';
import { PROVIDER_COLORS, PROVIDER_LABELS, SEVERITY_COLORS, STATUS_COLORS, money, number, pct, timeAgo } from '@/lib/format';
import { useVmFilter } from './vmFilter';
import { copyText } from '@/lib/clipboard';
import type { BoardPanel } from '@/lib/types';

export const WIDGET_CATALOG: { kind: string; label: string; desc: string }[] = [
  { kind: 'mgmt-kpis', label: 'Overview KPIs', desc: 'Assets, accounts, alerts, compliance, cost.' },
  { kind: 'cloud-dist', label: 'Cloud Distribution', desc: 'Resources by provider (%).' },
  { kind: 'cost-dist', label: 'Cost Distribution', desc: 'Spend by provider — click “Drill down cost” to break down by service / region / resource.' },
  { kind: 'security-overview', label: 'Security Overview', desc: 'Findings by severity.' },
  { kind: 'cost-drivers', label: 'Top Cost Drivers', desc: 'Top services by spend.' },
  { kind: 'incidents', label: 'Recent Incidents', desc: 'Latest events.' },
  { kind: 'requests', label: 'Provisioning Requests', desc: 'Deploy request history — status, failure phase, retry.' },
  { kind: 'vms', label: 'Virtual Machines', desc: 'Power control + remote access table.' },
  { kind: 'rules', label: 'Alert Rules', desc: 'Threshold rules — add/edit/toggle.' },
  { kind: 'kpis', label: 'Monitoring KPIs', desc: 'CPU, memory, disk, network, latency, error-rate tiles.' },
  { kind: 'trend', label: 'Metric Trend', desc: 'CPU / Memory / Disk / Network / Latency / Error over time — switchable per widget.' },
  { kind: 'guest-agents', label: 'Guest Agents', desc: 'Guest agents — online status + CPU/mem/disk telemetry per host.' },
  { kind: 'os-inventory', label: 'OS Inventory', desc: 'Hosts by OS type → version; drill down to up/down IP, open ports, active connections & apps.' },
  { kind: 'ai-engine', label: 'Cloud AI Engine', desc: 'AIOps status, CPU forecast, anomalies & insight.' },
  { kind: 'top-consumers', label: 'Top Resource Consumers', desc: 'Highest-CPU resources across the fleet.' },
  { kind: 'automation', label: 'Automation Workflows', desc: 'Workflows, triggers, run counts and status.' },
  { kind: 'telemetry', label: 'Per-VM Telemetry', desc: 'CPU/mem/disk/net per VM.' },
  { kind: 'services', label: 'Running Services', desc: 'Top processes per VM with CPU% / Mem% usage (Task-Manager style, from the guest agent).' },
  { kind: 'vmdetail', label: 'Selected VM Detail', desc: 'CPU / mem / disk / network + services for the VM chosen in the VM filter (blank when "All VMs").' },
  { kind: 'health', label: 'Service Health Map', desc: 'Up/degraded/down per service.' },
  { kind: 'fleet-type', label: 'Fleet by Type', desc: 'Up/down charts by Windows / Linux / Docker / firewall / router / switch — click a type to filter.' },
  { kind: 'ipmon', label: 'IP / Host Monitor', desc: 'Up/down checks for IPs & hosts with uptime.' },
  { kind: 'netdevices', label: 'Network Devices', desc: 'Firewall/router/switch — bandwidth, uptime, jitter, link alerts, connected MACs (SNMP).' },
  { kind: 'cost', label: 'Cost by Service', desc: 'Spend breakdown (bar).' },
  { kind: 'resources', label: 'Resources by Provider', desc: 'Inventory split (donut).' },
  { kind: 'alerts', label: 'Active Alerts', desc: 'Live alerts from the engine (also consolidated in Activity & Event Tracking).' },
  { kind: 'events', label: 'System Event Log', desc: 'Platform activity feed (also consolidated in Activity & Event Tracking).' },
  { kind: 'compliance', label: 'Compliance Overview', desc: 'CIS / ISO / PCI / HIPAA benchmark scores (primary home: Governance).' },
  { kind: 'zerotrust', label: 'Zero-Trust Posture', desc: 'CISA pillar scores + maturity band (from Security).' },
  { kind: 'predictive', label: 'Predictive Alerts', desc: 'Fleet risk score, next-hour forecast, at-risk resources (from Activity).' },
  { kind: 'zerotrust-full', label: 'Zero-Trust Posture (full)', desc: 'Full CISA pillar scorecard with drill-down remediation (Security).' },
  { kind: 'findings', label: 'Cloud Security Findings', desc: 'VAPT + cloud-native findings; scan & refresh (Security).' },
  { kind: 'alert-rules', label: 'Alert Rules (full)', desc: 'Threshold rules on live metrics — add / edit / pause (Security).' },
  { kind: 'automation-full', label: 'Automation (full)', desc: 'Automation workflows — trigger → actions → escalation editor (Security).' },
  { kind: 'delivery-channels', label: 'Delivery Channels', desc: 'Notification channels — Slack / Email / Webhook / PagerDuty / WhatsApp / Group (Security).' },
  { kind: 'environments', label: 'Environments', desc: 'Resource count + violations per environment (Governance).' },
  { kind: 'policies', label: 'Policies', desc: 'Governance guardrails — add / edit / pause + violations (Governance).' },
  { kind: 'firewall-risks', label: 'Risky Firewall / NSG Rules', desc: 'Public-exposure & risky rules with scan + remediate (Network).' },
  { kind: 'public-exposure', label: 'Public Exposure', desc: 'Resources with a public IP (Network).' },
  { kind: 'net-inventory', label: 'Network Inventory', desc: 'Network resource counts by kind/provider (Network).' },
  { kind: 'net-segments', label: 'Network Segments', desc: 'Network resources grouped by segment (Network).' },
  { kind: 'link-health', label: 'Link Latency & Health', desc: 'Up/down + latency trend per monitored link (Network).' },
  { kind: 'net-throughput', label: 'Per-VM Network Throughput', desc: 'Network Mbps per compute instance (Network).' },
  { kind: 'fin-trend', label: 'Spend Trend & Forecast', desc: 'Monthly spend with linear-regression forecast (FinOps).' },
  { kind: 'fin-breakdowns', label: 'Cost Breakdowns', desc: 'Spend by provider / service / environment / region / type (FinOps).' },
  { kind: 'fin-drivers', label: 'Top Cost Drivers', desc: 'Most expensive resources, with CPU and monthly cost (FinOps).' },
  { kind: 'fin-savings', label: 'Savings & Anomalies', desc: 'Rightsizing/waste savings + spend anomalies (FinOps).' },
  { kind: 'fin-budgets', label: 'Budgets', desc: 'Spend vs ceiling with burn status — add / edit (FinOps).' },
  { kind: 'carbon-equivalents', label: 'Carbon Equivalents', desc: 'Annual emissions as trees / cars / homes / flights (Sustainability).' },
  { kind: 'carbon-trend', label: 'Emissions Trend', desc: '7-month CO₂e trend (Sustainability).' },
  { kind: 'carbon-breakdowns', label: 'Emissions Breakdowns', desc: 'CO₂e by provider / region / environment (Sustainability).' },
  { kind: 'carbon-grid', label: 'Grid Intensity & Clean Energy', desc: 'Dirtiest-grid leaderboard + provider renewable coverage (Sustainability).' },
  { kind: 'carbon-recommendations', label: 'Decarbonisation Opportunities', desc: 'Ranked emission-reduction actions (Sustainability).' },
  { kind: 'siem', label: 'SIEM Event Stream', desc: 'Live security event stream from agents & monitors (Activity).' },
  { kind: 'audit', label: 'Security Audit Trail', desc: 'Who did what, when, from where (Activity).' },
  { kind: 'ai-anomaly-feed', label: 'Anomaly Feed', desc: 'Cost / behaviour / threshold detections with confirm-dismiss review (AI Engine).' },
  { kind: 'ai-anomaly-quality', label: 'Anomaly Detection Quality', desc: 'Rolling precision, FP-rate, recall & MTTD + control-trial runner (AI Engine).' },
  { kind: 'ai-validation', label: 'Validation Suite', desc: 'Thesis test matrix with live evidence — anomaly battery, RCA top-k, correlation, CIEM (AI Engine).' },
];

export function defaultSize(kind: string): { w: number; h: number } {
  switch (kind) {
    case 'kpis': return { w: 12, h: 7 };
    case 'mgmt-kpis': return { w: 12, h: 4 };
    case 'telemetry': return { w: 7, h: 8 };
    case 'services': return { w: 6, h: 8 };
    case 'vmdetail': return { w: 6, h: 8 };
    case 'vms': return { w: 12, h: 9 };
    case 'rules': return { w: 12, h: 6 };
    case 'ipmon': return { w: 6, h: 9 };
    case 'netdevices': return { w: 12, h: 9 };
    case 'events':
    case 'incidents':
    case 'requests': return { w: 6, h: 8 };
    case 'fleet-type': return { w: 6, h: 7 };
    case 'os-inventory': return { w: 12, h: 12 };
    case 'guest-agents': return { w: 8, h: 8 };
    case 'ai-engine': return { w: 5, h: 7 };
    case 'top-consumers': return { w: 4, h: 6 };
    case 'automation': return { w: 6, h: 6 };
    case 'zerotrust': return { w: 6, h: 6 };
    case 'predictive': return { w: 6, h: 5 };
    case 'zerotrust-full': return { w: 12, h: 11 };
    case 'findings': return { w: 7, h: 10 };
    case 'alert-rules': return { w: 12, h: 8 };
    case 'automation-full': return { w: 6, h: 8 };
    case 'delivery-channels': return { w: 6, h: 8 };
    case 'environments': return { w: 12, h: 5 };
    case 'policies': return { w: 12, h: 9 };
    case 'firewall-risks': return { w: 12, h: 9 };
    case 'public-exposure': return { w: 7, h: 8 };
    case 'net-inventory': return { w: 5, h: 8 };
    case 'net-segments': return { w: 12, h: 5 };
    case 'link-health': return { w: 12, h: 8 };
    case 'net-throughput': return { w: 12, h: 8 };
    case 'fin-trend': return { w: 6, h: 6 };
    case 'fin-breakdowns': return { w: 6, h: 11 };
    case 'fin-drivers': return { w: 12, h: 7 };
    case 'fin-savings': return { w: 6, h: 8 };
    case 'fin-budgets': return { w: 12, h: 5 };
    case 'carbon-equivalents': return { w: 12, h: 4 };
    case 'carbon-trend': return { w: 6, h: 5 };
    case 'carbon-breakdowns': return { w: 6, h: 8 };
    case 'carbon-grid': return { w: 6, h: 9 };
    case 'carbon-recommendations': return { w: 6, h: 7 };
    case 'siem': return { w: 6, h: 8 };
    case 'audit': return { w: 6, h: 8 };
    case 'ai-anomaly-feed': return { w: 12, h: 10 };
    case 'ai-anomaly-quality': return { w: 12, h: 6 };
    case 'ai-validation': return { w: 12, h: 12 };
    case 'health':
    case 'security-overview': return { w: 5, h: 5 };
    case 'resources': return { w: 4, h: 6 };
    default: return { w: 6, h: 6 };
  }
}

const CHART_KINDS = new Set(['cloud-dist', 'cost-dist', 'security-overview', 'cost-drivers', 'cost', 'resources']);
export function chartOptions(kind: string): string[] | null {
  return CHART_KINDS.has(kind) ? ['bar', 'donut', 'pie', 'list'] : null;
}

export function WidgetContent({ panel, onConfig }: { panel: BoardPanel; onConfig?: (patch: Partial<BoardPanel>) => void }) {
  const chart = panel.cfg?.chart;
  // Persist a cfg patch (scope/chart/label/hideLabel) back onto the saved panel.
  const cfgPatch = onConfig ? (patch: any) => onConfig({ cfg: { ...panel.cfg, ...patch } }) : undefined;
  // Prepend the optional centered, editable panel name (cfg.label / cfg.hideLabel).
  const labeled = (node: ReactNode): ReactNode => (<><WidgetLabel label={panel.cfg?.label as string} hidden={!!panel.cfg?.hideLabel} onConfig={cfgPatch} />{node}</>);
  switch (panel.kind) {
    case 'mgmt-kpis': return <MgmtKpis />;
    case 'cloud-dist': return <CloudDist chart={chart} />;
    case 'cost-dist': return <CostDist chart={chart} />;
    case 'security-overview': return <SecurityOverview chart={chart} />;
    case 'compliance': return <Compliance />;
    case 'cost-drivers': return <CostDrivers chart={chart} />;
    case 'incidents': return <Incidents />;
    case 'requests': return <ProvisionRequests />;
    case 'kpis': return <Kpis />;
    case 'trend': return <Trend metric={(panel.cfg?.metric as string) ?? 'cpu'} onConfig={onConfig ? (m) => onConfig({ cfg: { ...panel.cfg, metric: m } }) : undefined} />;
    case 'alerts': return <Alerts />;
    case 'telemetry': return <Telemetry />;
    case 'services': return <Services />;
    case 'vmdetail': return <VmDetail />;
    case 'health': return <Health />;
    case 'fleet-type': return <FleetByType cfg={panel.cfg} onConfig={onConfig} />;
    case 'os-inventory': return <OsInventoryWidget />;
    case 'guest-agents': return labeled(<GuestAgents scope={(panel.cfg?.group as string) ?? 'all'} onConfig={cfgPatch} />);
    case 'ai-engine': return <AiEngineWidget />;
    case 'top-consumers': return <TopConsumersWidget />;
    case 'automation': return <AutomationWidget />;
    case 'zerotrust': return <ZeroTrustWidget />;
    case 'predictive': return <PredictiveWidget />;
    case 'zerotrust-full': return <ZeroTrustPosture bare />;
    case 'findings': return <FindingsPanel bare />;
    case 'alert-rules': return <RulesPanel bare />;
    case 'automation-full': return <AutomationPanel bare />;
    case 'delivery-channels': return <DeliveryChannelsPanel bare />;
    case 'environments': return <EnvironmentsPanel bare />;
    case 'policies': return <PoliciesPanel bare />;
    case 'firewall-risks': return <FirewallRisksPanel bare />;
    case 'public-exposure': return <PublicExposurePanel bare />;
    case 'net-inventory': return <NetworkInventoryPanel bare />;
    case 'net-segments': return <NetworkSegmentsPanel bare />;
    case 'link-health': return <LinkHealthPanel bare />;
    case 'net-throughput': return <NetworkThroughputPanel bare />;
    case 'fin-trend': return <CostTrendPanel bare />;
    case 'fin-breakdowns': return <CostBreakdownsPanel bare />;
    case 'fin-drivers': return <CostDriversPanel bare />;
    case 'fin-savings': return <CostOptimizationPanel bare />;
    case 'fin-budgets': return <BudgetsPanel bare />;
    case 'carbon-equivalents': return <CarbonEquivalentsPanel bare />;
    case 'carbon-trend': return <CarbonTrendPanel bare />;
    case 'carbon-breakdowns': return <CarbonBreakdownsPanel bare />;
    case 'carbon-grid': return <CarbonGridPanel bare />;
    case 'carbon-recommendations': return <CarbonRecommendationsPanel bare />;
    case 'siem': return <SiemStreamPanel bare />;
    case 'audit': return <AuditTrailPanel bare />;
    case 'ai-anomaly-feed': return <AnomalyFeedPanel />;
    case 'ai-anomaly-quality': return <AnomalyQualityCard />;
    case 'ai-validation': return <ValidationPanel />;
    case 'events': return <Events />;
    case 'vms': return <VmsTable bare />;
    case 'rules': return <RulesManager bare />;
    case 'ipmon': return labeled(<IpMonitorPanel embedded scope={(panel.cfg?.group as string) ?? ''} chartType={(panel.cfg?.chart as string) ?? 'line'} onConfig={cfgPatch} />);
    case 'netdevices': return labeled(<NetworkDevicesPanel bare scope={(panel.cfg?.group as string) ?? 'all'} chartType={(panel.cfg?.chart as string) ?? 'table'} onConfig={cfgPatch} />);
    case 'cost': return <DatasetCat dataset="cost-by-service" chart={chart} money />;
    case 'resources': return <DatasetCat dataset="resources-by-provider" chart={chart} />;
    default: return <div className="text-2xs text-muted">Unknown widget</div>;
  }
}

/** Render a {label,value} series as bar / donut / pie / list (chart switcher). */
function CategoryRender({ data, chart, fmt }: { data: { label: string; value: number }[]; chart?: string; fmt?: (n: number) => string }) {
  if (data.length === 0) return <div className="py-6 text-center text-2xs text-muted">No data.</div>;
  const c = chart ?? 'bar';
  if (c === 'donut' || c === 'pie') return <CategoryPie data={data} donut={c === 'donut'} height={190} fmt={fmt} />;
  if (c === 'list') {
    return (
      <div className="divide-y divide-border-soft">
        {data.map((d) => (
          <div key={d.label} className="flex items-center justify-between py-1.5 text-xs">
            <span className="truncate capitalize text-muted-light">{d.label}</span>
            <span className="font-medium text-white">{fmt ? fmt(d.value) : number(d.value)}</span>
          </div>
        ))}
      </div>
    );
  }
  return <CategoryBar data={data} height={190} />;
}

// ── Management overview widgets ────────────────────────────────────
function MgmtKpis() {
  const { data } = useManagementSummary();
  const k = data?.kpis;
  const cur = data?.currency ?? 'USD';
  // [label, value, color, drill-down href] — clicking a KPI opens the exact data behind it.
  const tiles: [string, string, string, string][] = [
    ['Total Assets', k ? number(k.totalAssets) : '—', '#3b82f6', '/inventory'],
    ['Running', k ? number(k.runningResources) : '—', '#22c55e', '/vms'],
    ['Accounts', k ? number(k.cloudAccounts) : '—', '#06b6d4', '/connections'],
    ['Alerts', k ? number(k.securityAlerts) : '—', '#ef4444', '/security#alerts'],
    ['Compliance', k ? pct(k.complianceScore) : '—', '#f59e0b', '/governance'],
    ['Monthly Cost', k ? money(k.monthlyCost, cur, true) : '—', '#a855f7', '/reports'],
  ];
  return (
    <div className="grid h-full grid-cols-3 gap-2 sm:grid-cols-6">
      {tiles.map(([l, v, c, href]) => (
        <a key={l} href={href} title={`View ${l}`} className="widget-action group rounded-lg border border-border bg-card-hover/40 p-2 text-center transition hover:border-brand/50 hover:bg-card-hover">
          <div className="text-base font-semibold" style={{ color: c }}>{v}</div>
          <div className="flex items-center justify-center gap-1 text-2xs text-muted">{l}<span className="opacity-0 transition group-hover:opacity-100">↗</span></div>
        </a>
      ))}
    </div>
  );
}

function CloudDist({ chart }: { chart?: string }) {
  const { data } = useManagementSummary();
  const d = (data?.cloudDistribution ?? []).map((x) => ({ label: PROVIDER_LABELS[x.provider], value: x.pct }));
  return <CategoryRender data={d} chart={chart} fmt={(n) => `${n}%`} />;
}

function CostDist({ chart }: { chart?: string }) {
  const { data } = useManagementSummary();
  const fin = useFinOpsOverview();
  const [drill, setDrill] = useState(false);
  const cur = data?.currency ?? 'USD';
  const d = (data?.costDistribution ?? []).map((x) => ({ label: PROVIDER_LABELS[x.provider], value: x.cost }));
  const canDrill = (fin.data?.resources?.length ?? 0) > 0;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1"><CategoryRender data={d} chart={chart} fmt={(n) => money(n, cur)} /></div>
      {canDrill && (
        <button onClick={() => setDrill(true)} className="widget-action mt-1 self-end text-2xs font-medium text-brand hover:underline">
          Drill down cost →
        </button>
      )}
      {drill && fin.data && (
        <Modal title="Cost Distribution — drill-down" subtitle="Group by any dimension and click a bar to drill into provider → service → region → resource." onClose={() => setDrill(false)}>
          <CostDrillDown resources={fin.data.resources} currency={fin.data.currency} />
        </Modal>
      )}
    </div>
  );
}

function SecurityOverview({ chart }: { chart?: string }) {
  const { data } = useManagementSummary();
  const s = data?.securityOverview;
  const d = (['critical', 'high', 'medium', 'low'] as const).map((x) => ({ label: x, value: s?.[x] ?? 0 }));
  return <CategoryRender data={d} chart={chart} />;
}

export function Compliance() {
  const { data } = useManagementSummary();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      {(data?.complianceOverview ?? []).map((f) => (
        <div key={f.name}>
          <div className="mb-1 flex justify-between text-2xs"><span className="text-white">{f.name}</span><span className="text-muted-light">{f.score}%</span></div>
          <ProgressBar value={f.score} color={f.score >= 85 ? '#22c55e' : f.score >= 70 ? '#f59e0b' : '#ef4444'} />
        </div>
      ))}
      <div className="flex items-center justify-between pt-1">
        <span className="text-2xs text-muted">{data?.complianceSource === 'defender' ? 'Live from Defender' : data?.complianceSource === 'checklist' ? 'From your checklist' : 'Estimated from findings'}</span>
        <button onClick={() => setOpen(true)} className="widget-action text-2xs font-medium text-brand hover:underline">Manage benchmarks →</button>
      </div>
      {open && <ComplianceDetail onClose={() => setOpen(false)} />}
    </div>
  );
}

function CostDrivers({ chart }: { chart?: string }) {
  const { data } = useManagementSummary();
  const cur = data?.currency ?? 'USD';
  const d = (data?.topCostDrivers ?? []).map((x) => ({ label: x.name, value: x.cost }));
  return <CategoryRender data={d} chart={chart ?? 'list'} fmt={(n) => money(n, cur)} />;
}

function Incidents() {
  const { data } = useIncidents();
  const items = data ?? [];
  if (items.length === 0) return <div className="py-4 text-center text-2xs text-muted">No open incidents.</div>;
  return (
    <div className="divide-y divide-border-soft">
      {items.map((e) => (
        <div key={e.id} className="flex items-center justify-between gap-2 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY_COLORS[e.severity] }} />
            <span className="min-w-0">
              <span className="block truncate text-2xs text-white">{e.title}</span>
              {e.resourceName && <span className="block truncate text-2xs text-muted">{e.resourceName}</span>}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2 text-2xs text-muted">
            <span className="capitalize">{e.status}</span>
            <span>{timeAgo(e.openedAt)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ProvisionRequests() {
  const { data } = useApprovals();
  const retry = useRetryRequest();
  const reqs = (data ?? []).filter((r) => r.action?.endsWith('_provision') || r.action === 'vpn_request');
  const color: Record<string, string> = { executed: '#22c55e', failed: '#ef4444', pending: '#f59e0b', rejected: '#64748b', expired: '#64748b' };
  return (
    <div className="divide-y divide-border-soft">
      {reqs.length === 0 && <div className="py-6 text-center text-2xs text-muted">No provisioning requests yet.</div>}
      {reqs.map((r) => {
        const c = color[r.status] ?? '#64748b';
        return (
          <div key={r.id} className="py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c }} />
                <span className="truncate text-2xs text-white" title={r.title}>{r.title}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="rounded px-1.5 py-0.5 text-2xs capitalize" style={{ background: `${c}22`, color: c }}>{r.status === 'executed' ? 'deployed' : r.status === 'failed' ? 'not deployed' : r.status}</span>
                {r.status === 'failed' && r.retryable && (
                  <button onClick={() => retry.mutate(r.id)} disabled={retry.isPending} className="rounded bg-brand/15 px-1.5 py-0.5 text-2xs text-brand hover:bg-brand/25 disabled:opacity-50">↻</button>
                )}
              </div>
            </div>
            {r.status === 'failed' && (r.phase || r.remediation) && (
              <div className="mt-1 pl-4 text-2xs text-danger">{r.phase ? `Failed at “${r.phase}”. ` : ''}<span className="text-amber-300/90">{r.remediation}</span></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Monitoring KPIs — CPU / Memory / Disk / Network / Latency / Error-rate, plus the running
 * services of a VM. A common VM filter scopes every tile to one VM (memory/disk/network and
 * services come from that VM's guest agent); "All VMs" shows the fleet average.
 */
function Kpis() {
  const { data } = useMonitoring();
  const tel = useTelemetry();
  const agents = useAgents();
  const [vmId, setVmId] = useVmFilter();
  const k = data?.kpis;
  const vms = tel.data ?? [];
  const sel = vmId === 'all' ? null : vms.find((v) => v.id === vmId) ?? null;
  const agent = sel ? (agents.data ?? []).find((a) => a.resourceId === sel.id || a.name === sel.name) ?? null : null;
  const services = agent?.services ?? [];

  const tiles: [string, string, string, string][] = sel
    ? [
        ['CPU', pct(sel.cpuPct), '#3b82f6', '/vms'],
        ['Memory', sel.memoryPct > 0 ? pct(sel.memoryPct) : '—', '#22c55e', '/vms'],
        ['Disk', sel.diskPct != null ? pct(sel.diskPct) : '—', '#f59e0b', '/vms'],
        ['Network', sel.networkMbps != null ? `${sel.networkMbps} Mbps` : agent?.netMbps != null ? `${agent.netMbps.toFixed(1)} Mbps` : '—', '#a855f7', '/vms'],
        ['Latency', '—', '#06b6d4', '/monitoring'],
        ['Error Rate', '—', '#ef4444', '/monitoring'],
      ]
    : [
        ['Avg CPU', k ? pct(k.avgCpu) : '—', '#3b82f6', '/monitoring'],
        ['Memory', k?.memoryHasData ? pct(k.avgMemory) : '—', '#22c55e', '/monitoring'],
        ['Disk', k?.diskHasData ? pct(k.avgDisk) : '—', '#f59e0b', '/monitoring'],
        ['Network', k ? `${k.networkMbps} Mbps` : '—', '#a855f7', '/monitoring'],
        ['Latency', k?.latency != null ? `${k.latency} ms` : '—', '#06b6d4', '/monitoring'],
        ['Error Rate', k ? pct(k.errorRate) : '—', '#ef4444', '/monitoring'],
      ];

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs text-muted">VM filter:</span>
        <select value={vmId} onChange={(e) => setVmId(e.target.value)} className="widget-action max-w-[220px] rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white focus:border-brand focus:outline-none">
          <option value="all">All VMs · fleet average</option>
          {vms.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        {sel && <span className="text-2xs text-muted">· <span className="capitalize">{sel.status}</span>{agent ? '' : ' · no agent (mem/disk/services need the agent)'}</span>}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {tiles.map(([l, v, c, href]) => (
          <a key={l} href={href} title={`View ${l}`} className="widget-action group rounded-lg border border-border bg-card-hover/40 p-2 text-center transition hover:border-brand/50 hover:bg-card-hover">
            <div className="text-base font-semibold" style={{ color: c }}>{v}</div>
            <div className="flex items-center justify-center gap-1 text-2xs text-muted">{l}<span className="opacity-0 transition group-hover:opacity-100">↗</span></div>
          </a>
        ))}
      </div>

      {sel && (
        <div className="min-h-0 flex-1 rounded-lg border border-border bg-card/40 p-2">
          <div className="mb-1 text-2xs font-semibold text-white">Services running on {sel.name}{services.length > 0 ? ` (${services.length})` : ''}</div>
          {services.length === 0 ? (
            <div className="text-2xs text-muted">{agent ? 'No services reported by the agent yet.' : 'No MCMF agent on this VM — install it (Command Center → Guest Agents, or Help) to see memory, disk and running services.'}</div>
          ) : (
            <div className="flex max-h-28 flex-wrap gap-1 overflow-auto">
              {services.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded bg-bg px-1.5 py-0.5 text-2xs text-muted-light" title={s.status}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.status === 'running' ? '#22c55e' : '#64748b' }} />{s.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TREND_META: Record<string, { label: string; color: string; unit: string }> = {
  cpu: { label: 'CPU', color: '#3b82f6', unit: '%' },
  memory: { label: 'Memory', color: '#22c55e', unit: '%' },
  disk: { label: 'Disk used', color: '#f59e0b', unit: '%' },
  network: { label: 'Network', color: '#a855f7', unit: ' Mbps' },
  latency: { label: 'Latency', color: '#06b6d4', unit: ' ms' },
  jitter: { label: 'Jitter', color: '#ec4899', unit: ' ms' },
  error: { label: 'Error rate', color: '#ef4444', unit: '%' },
};
const TREND_METRICS = ['cpu', 'memory', 'disk', 'network', 'latency', 'jitter', 'error'] as const;
/** Shared list for the "Add Widget" metric picker. */
export const TREND_METRIC_OPTIONS: [string, string][] = TREND_METRICS.map((m) => [m, TREND_META[m].label]);

/** Metric trend over time — VM-scoped via the shared filter; switchable metric per widget. */
function Trend({ metric, onConfig }: { metric: string; onConfig?: (m: string) => void }) {
  const m = TREND_META[metric] ? metric : 'cpu';
  const [vmId] = useVmFilter();
  const tel = useTelemetry();
  const perVm = ['cpu', 'memory', 'disk', 'network'].includes(m);
  const scopedVm = vmId !== 'all' ? vmId : 'all';
  const ts = useTimeseries(m as any, scopedVm);
  const meta = TREND_META[m];
  const vmName = vmId !== 'all' ? tel.data?.find((v) => v.id === vmId)?.name : null;
  return (
    <div className="flex h-full flex-col gap-1">
      {onConfig && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs text-muted">Metric:</span>
          <select value={m} onChange={(e) => onConfig(e.target.value)} className="widget-action rounded-md border border-border bg-bg px-2 py-0.5 text-2xs text-white focus:border-brand focus:outline-none">
            {TREND_METRICS.map((x) => <option key={x} value={x}>{TREND_META[x].label}</option>)}
          </select>
          {vmName && <span className="rounded bg-brand/15 px-1.5 py-0.5 text-2xs text-brand">{perVm ? vmName : `${vmName} · fleet*`}</span>}
        </div>
      )}
      {!onConfig && vmName && <div className="text-2xs text-muted">{perVm ? `VM: ${vmName}` : `${vmName} (fleet — ${meta.label.toLowerCase()} isn't per-VM)`}</div>}
      <div className="min-h-0 flex-1">
        <AreaTrend data={ts.data ?? []} color={meta.color} height={onConfig ? 140 : 150} unit={meta.unit} />
      </div>
    </div>
  );
}

function Alerts() {
  const { data } = useAlerts('active');
  const ack = useAckAlert();
  const resolve = useResolveAlert();
  const active = (data ?? []).filter((a) => a.status !== 'resolved');
  if (active.length === 0) return <div className="py-6 text-center text-2xs text-muted">No active alerts.</div>;
  return (
    <div className="divide-y divide-border-soft">
      {active.map((a) => (
        <div key={a.id} className="flex items-center justify-between gap-2 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY_COLORS[a.severity] }} />
            <span className="min-w-0">
              <span className="block truncate text-2xs text-white">{a.title}</span>
              <span className="block text-2xs text-muted">{a.source} · {timeAgo(a.raisedAt)}</span>
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {a.escalated && <span className="rounded bg-purple/15 px-1 py-0.5 text-2xs text-purple">esc</span>}
            <span className="text-2xs capitalize" style={{ color: SEVERITY_COLORS[a.severity] }}>{a.severity}</span>
            {a.status === 'active' && <button onClick={() => ack.mutate(a.id)} className="widget-action rounded border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-light hover:text-white">ack</button>}
            <button onClick={() => resolve.mutate(a.id)} className="widget-action rounded border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-light hover:text-white">resolve</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Telemetry() {
  const { data } = useTelemetry();
  return (
    <table className="w-full text-2xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1">VM</th><th className="py-1">CPU</th><th className="py-1">Mem</th><th className="py-1">Disk</th><th className="py-1">Net</th>
        </tr>
      </thead>
      <tbody>
        {(data ?? []).map((v) => (
          <tr key={v.id} className="border-t border-border-soft">
            <td className="py-1 text-white"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: STATUS_COLORS[v.status] }} />{v.name}</td>
            <td className="py-1 text-muted-light">{pct(v.cpuPct)}</td>
            <td className="py-1 text-muted-light">{v.memoryPct > 0 ? pct(v.memoryPct) : '—'}</td>
            <td className="py-1 text-muted-light">{v.diskPct != null ? pct(v.diskPct) : '—'}</td>
            <td className="py-1 text-muted-light">{v.networkMbps != null ? v.networkMbps : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const procColor = (v: number) => (v >= 50 ? '#ef4444' : v >= 20 ? '#f59e0b' : v >= 5 ? '#94a3b8' : '#64748b');

/** Task-Manager-style process table: name · CPU% · Mem%, sorted by CPU. */
function ProcTable({ procs }: { procs: { name: string; status: string; cpu?: number; mem?: number }[] }) {
  const rows = procs
    .filter((p) => p.name && p.name !== 'ps') // the sampling command itself reports a spurious spike
    .map((p) => ({ ...p, cpu: p.cpu != null ? Math.min(p.cpu, 100) : p.cpu }))
    .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || (b.mem ?? 0) - (a.mem ?? 0));
  return (
    <table className="w-full text-2xs">
      <thead>
        <tr className="text-left text-muted"><th className="py-0.5">Process</th><th className="w-16 text-right">CPU</th><th className="w-16 text-right">Mem</th></tr>
      </thead>
      <tbody>
        {rows.map((p, i) => (
          <tr key={i} className="border-t border-border-soft">
            <td className="max-w-[200px] truncate py-0.5 font-mono text-white" title={`${p.name} · ${p.status}`}>{p.name}</td>
            <td className="text-right tabular-nums" style={{ color: procColor(p.cpu ?? 0) }}>{p.cpu != null ? `${p.cpu.toFixed(1)}%` : '—'}</td>
            <td className="text-right tabular-nums" style={{ color: procColor(p.mem ?? 0) }}>{p.mem != null ? `${p.mem.toFixed(1)}%` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Running Services per VM — expand a VM to see its top processes + usage (from the guest agent). */
function Services() {
  const { data } = useAgents();
  const [vmId] = useVmFilter();
  const tel = useTelemetry();
  const [open, setOpen] = useState<string | null>(null);
  let agents = (data ?? []).filter((a) => (a.services?.length ?? 0) > 0 || a.online);
  if (vmId !== 'all') {
    const selName = tel.data?.find((v) => v.id === vmId)?.name;
    agents = agents.filter((a) => a.resourceId === vmId || a.name === selName || a.hostname === selName);
  }
  if (agents.length === 0) return <div className="py-6 text-center text-2xs text-muted">{vmId !== 'all' ? 'No guest agent on the selected VM — install the MCMF agent to see its services.' : 'No agents reporting services yet. Install the MCMF guest agent (Command Center → Guest Agents, or Help) to capture running services per VM.'}</div>;
  return (
    <div className="divide-y divide-border-soft">
      {agents.map((a) => {
        const svcs = a.services ?? [];
        const running = svcs.filter((s) => s.status === 'running').length;
        const isOpen = open === a.id;
        return (
          <div key={a.id}>
            <button onClick={() => setOpen(isOpen ? null : a.id)} className="flex w-full items-center justify-between gap-2 py-1.5 text-left hover:bg-card-hover">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: a.online ? '#22c55e' : '#64748b' }} title={a.online ? 'online' : 'offline'} />
                <span className="truncate text-2xs text-white">{a.hostname ?? a.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted"><span className="text-white">{running}</span> running {isOpen ? '▾' : '▸'}</span>
            </button>
            {isOpen && (
              <div className="px-4 pb-2">
                {svcs.length === 0 ? <span className="text-2xs text-muted">No process data reported by the agent yet.</span> : <ProcTable procs={svcs} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Selected-VM detail — CPU/mem/disk/network + running services. Driven by the shared VM filter;
 *  shows nothing (a prompt) when "All VMs" is selected. */
function VmDetail() {
  const [vmId] = useVmFilter();
  const tel = useTelemetry();
  const agents = useAgents();
  if (vmId === 'all') {
    return <div className="flex h-full items-center justify-center px-4 py-8 text-center text-2xs text-muted">Pick a specific VM in the <b className="mx-1 text-white">🖥 VM filter</b> (top of Monitoring) to see its CPU / memory / disk / network and running services here.</div>;
  }
  const vm = (tel.data ?? []).find((v) => v.id === vmId);
  if (!vm) return <div className="py-8 text-center text-2xs text-muted">Selected VM not found — it may be stopped or no longer discovered.</div>;
  const agent = (agents.data ?? []).find((a) => a.resourceId === vm.id || a.name === vm.name || a.hostname === vm.name);
  const svcs = agent?.services ?? [];
  const running = svcs.filter((s) => s.status === 'running');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLORS[vm.status] ?? '#64748b' }} />
        <span className="text-sm font-semibold text-white">{vm.name}</span>
        <span className="text-2xs capitalize text-muted">{PROVIDER_LABELS[vm.provider] ?? vm.provider} · {vm.region} · {vm.status}</span>
        {!agent && <span className="rounded bg-warning/15 px-1.5 text-2xs text-warning">no agent</span>}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricBar label="CPU" value={vm.cpuPct} />
        <MetricBar label="Memory" value={vm.memoryPct > 0 ? vm.memoryPct : null} />
        <MetricBar label="Disk used" value={vm.diskPct} />
        <ValueTile label="Network" value={vm.networkMbps != null ? `${vm.networkMbps} Mbps` : agent?.netMbps != null ? `${agent.netMbps.toFixed(1)} Mbps` : '—'} color="#a855f7" />
      </div>

      <div>
        <div className="mb-1 text-2xs font-semibold text-white">Top processes · CPU / Mem usage ({svcs.length})</div>
        {svcs.length === 0 ? (
          <div className="text-2xs text-muted">{agent ? 'No process data reported by the agent yet.' : 'Install the MCMF guest agent (Command Center → Guest Agents) to see processes, memory and disk for this VM.'}</div>
        ) : (
          <div className="max-h-44 overflow-auto"><ProcTable procs={svcs} /></div>
        )}
      </div>
    </div>
  );
}

/** A simple value tile (no bar) — for non-% metrics like Network. */
function ValueTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 p-2">
      <div className="text-2xs text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums" style={{ color }}>{value}</div>
    </div>
  );
}

/** A labeled % utilization bar (CPU / Memory / Disk). */
function MetricBar({ label, value }: { label: string; value: number | null }) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const c = v == null ? '#64748b' : v >= 90 ? '#ef4444' : v >= 70 ? '#f59e0b' : '#22c55e';
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 p-2">
      <div className="flex items-center justify-between text-2xs"><span className="text-muted">{label}</span><span className="font-semibold" style={{ color: c }}>{v == null ? '—' : `${Math.round(v)}%`}</span></div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-border"><div className="h-1.5 rounded-full transition-all" style={{ width: `${v ?? 0}%`, background: c }} /></div>
    </div>
  );
}

/** Fleet by Type — up/down per category (Windows / Linux / Docker / firewall / router / switch).
 *  Click a type tile to filter to that category's members; "All" shows an availability bar per type. */
function FleetByType({ cfg, onConfig }: { cfg?: Record<string, unknown>; onConfig?: (patch: Partial<BoardPanel>) => void }) {
  const vms = useVms();
  const monitors = useMonitors();
  const sel = (cfg?.fleetType as string) ?? 'all';
  const setSel = (k: string) => onConfig?.({ cfg: { ...cfg, fleetType: k } });

  const V = vms.data ?? [];
  const M = monitors.data ?? [];
  const cat = (key: string, label: string, icon: string, color: string, items: { name: string; ok: boolean }[]) => ({ key, label, icon, color, items, total: items.length, up: items.filter((x) => x.ok).length });
  const cats = [
    cat('linux', 'Linux', '🐧', '#f59e0b', V.filter((v) => v.provider === 'linux').map((v) => ({ name: v.name, ok: v.status === 'running' }))),
    cat('windows', 'Windows', '🪟', '#3b82f6', V.filter((v) => v.provider === 'windows').map((v) => ({ name: v.name, ok: v.status === 'running' }))),
    cat('docker', 'Docker', '🐳', '#06b6d4', V.filter((v) => v.provider === 'docker').map((v) => ({ name: v.name, ok: v.status === 'running' }))),
    cat('firewall', 'Firewall', '🛡', '#ef4444', M.filter((m) => m.deviceKind === 'firewall').map((m) => ({ name: m.name, ok: m.status === 'up' }))),
    cat('router', 'Router', '📡', '#a855f7', M.filter((m) => m.deviceKind === 'router').map((m) => ({ name: m.name, ok: m.status === 'up' }))),
    cat('switch', 'Switch', '🔀', '#22c55e', M.filter((m) => m.deviceKind === 'switch').map((m) => ({ name: m.name, ok: m.status === 'up' }))),
  ].filter((c) => c.total > 0);

  if (cats.length === 0) return <div className="py-6 text-center text-2xs text-muted">No VMs or network devices yet.</div>;
  const active = cats.find((c) => c.key === sel);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1.5">
        <button onClick={() => setSel('all')} className={`rounded-lg border px-2 py-1.5 text-center text-2xs transition ${sel === 'all' ? 'border-brand bg-brand/10' : 'border-border bg-card-hover/30 hover:border-brand/50'}`}>
          <div className="text-sm font-semibold text-white">{cats.reduce((s, c) => s + c.total, 0)}</div>
          <div className="text-muted">All</div>
        </button>
        {cats.map((c) => (
          <button key={c.key} onClick={() => setSel(c.key)} className={`rounded-lg border px-2 py-1.5 text-center text-2xs transition ${sel === c.key ? 'border-brand bg-brand/10' : 'border-border bg-card-hover/30 hover:border-brand/50'}`}>
            <div className="text-sm font-semibold" style={{ color: c.color }}>{c.up}<span className="text-muted">/{c.total}</span></div>
            <div className="text-muted">{c.icon} {c.label}</div>
          </button>
        ))}
      </div>

      {active ? (
        <div className="max-h-44 divide-y divide-border-soft overflow-auto rounded-lg border border-border">
          {active.items.map((it, i) => (
            <div key={i} className="flex items-center justify-between px-2.5 py-1 text-2xs">
              <span className="truncate text-white">{it.name}</span>
              <span className={`shrink-0 rounded px-1.5 ${it.ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>{it.ok ? 'up' : 'down'}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {cats.map((c) => {
            const p = c.total ? Math.round((c.up / c.total) * 100) : 0;
            return (
              <div key={c.key}>
                <div className="mb-0.5 flex items-center justify-between text-2xs"><span className="text-muted-light">{c.icon} {c.label}</span><span className="text-muted">{c.up}/{c.total} up · {p}%</span></div>
                <div className="h-1.5 w-full rounded-full bg-border"><div className="h-1.5 rounded-full" style={{ width: `${p}%`, background: p >= 80 ? '#22c55e' : p >= 40 ? '#f59e0b' : '#ef4444' }} /></div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Zero-Trust Posture widget — overall score, maturity, per-pillar bars. */
function ZeroTrustWidget() {
  const { data } = useZeroTrust();
  if (!data) return <div className="py-6 text-center text-2xs text-muted">Scoring posture…</div>;
  const c = (s: number) => (s >= 85 ? '#22c55e' : s >= 65 ? '#84cc16' : s >= 40 ? '#f59e0b' : '#ef4444');
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-2xl font-bold tabular-nums" style={{ color: c(data.score) }}>{data.score}<span className="text-xs text-muted">/100</span></span>
        <span className="rounded-full px-2 py-0.5 text-2xs font-semibold" style={{ background: `${c(data.score)}22`, color: c(data.score) }}>{data.maturity}</span>
      </div>
      <div className="space-y-1.5">
        {data.pillars.map((p) => (
          <div key={p.key}>
            <div className="mb-0.5 flex items-center justify-between text-2xs"><span className="text-muted-light">{p.icon} {p.name}</span><span className="font-medium" style={{ color: c(p.score) }}>{p.score}</span></div>
            <div className="h-1.5 w-full rounded-full bg-border"><div className="h-1.5 rounded-full" style={{ width: `${p.score}%`, background: c(p.score) }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Predictive Alerts widget — fleet risk score + headline forecast KPIs. */
function PredictiveWidget() {
  const { data } = useActivityPredictive();
  if (!data) return <div className="py-6 text-center text-2xs text-muted">Forecasting…</div>;
  const k = data.kpis;
  const rc = k.riskScore >= 66 ? '#ef4444' : k.riskScore >= 33 ? '#f59e0b' : '#22c55e';
  const tile = (label: string, val: number | string, color: string) => (
    <div className="rounded border border-border bg-card-hover/40 py-1.5 text-center"><div className="text-sm font-semibold" style={{ color }}>{val}</div><div className="text-2xs text-muted">{label}</div></div>
  );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1.5">
        {tile('Risk score', k.riskScore, rc)}
        {tile('Forecast /hr', k.forecastNextHour, '#a855f7')}
        {tile('At risk', k.atRisk, '#f59e0b')}
      </div>
      <div className="space-y-1">
        {data.predictions.filter((p) => p.willBreach || p.severity === 'critical').slice(0, 4).map((p) => (
          <div key={p.metric} className="flex items-center justify-between text-2xs"><span className="text-muted-light">{p.label} — {p.current}{p.unit}</span>{p.eta ? <span className="text-danger">breaches in {p.eta}</span> : <span className="text-warning">over threshold</span>}</div>
        ))}
        {data.predictions.every((p) => !p.willBreach && p.severity !== 'critical') && <div className="text-center text-2xs text-success">No imminent fleet threshold breaches.</div>}
      </div>
      {(data.resourceForecasts?.length ?? 0) > 0 && (
        <div className="space-y-1 border-t border-border-soft pt-1.5">
          <div className="text-2xs font-semibold text-white">Per‑host capacity forecast</div>
          {data.resourceForecasts.slice(0, 5).map((f) => (
            <div key={f.id + f.metric} className="flex items-center justify-between gap-2 text-2xs">
              <span className="min-w-0 truncate text-muted-light" title={`${f.name} (${f.provider})`}>{f.name} · {f.metric} {f.current}%</span>
              <span className={`shrink-0 ${f.etaMin < 1440 ? 'text-danger' : 'text-warning'}`}>→ {f.threshold}% in {f.eta}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Cloud AI Engine widget — AIOps status, CPU forecast, anomalies and insight. */
function AiEngineWidget() {
  const { data } = useCommandCenter();
  const e = data?.aiEngine;
  if (!e) return <div className="py-6 text-center text-2xs text-muted">AI engine warming up…</div>;
  return (
    <div className="space-y-2 text-2xs">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-purple">✨</span>
        <div><div className="text-xs font-semibold text-white">AIOps Engine</div><div className="text-muted">{e.model} · {Math.round(e.confidence * 100)}% confidence · {e.status}</div></div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-center">
        <div className="rounded border border-border bg-card-hover/40 py-1.5"><div className="text-sm font-semibold text-white">{e.anomaliesDetected}</div><div className="text-muted">Anomalies</div></div>
        <div className="rounded border border-border bg-card-hover/40 py-1.5"><div className="text-sm font-semibold text-white">{e.forecast ? `${e.forecast.predicted}%` : '—'}</div><div className="text-muted">CPU forecast {e.forecast ? `(${e.forecast.trend})` : ''}</div></div>
      </div>
      <div className="rounded border border-brand/20 bg-brand/5 p-2 text-muted-light"><span className="font-medium text-brand">Insight · </span>{e.insight}</div>
      {e.anomalies?.slice(0, 4).map((a, i) => <div key={i} className="flex items-start gap-1.5 text-muted-light"><span className="text-danger">▲</span><span>{a.note}</span></div>)}
    </div>
  );
}

/** Top Resource Consumers widget — highest-CPU resources. */
function TopConsumersWidget() {
  const { data } = useCommandCenter();
  const rows = data?.topConsumers ?? [];
  if (rows.length === 0) return <div className="py-6 text-center text-2xs text-muted">No telemetry yet.</div>;
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.id}>
          <div className="mb-1 flex items-center justify-between text-2xs">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-light"><span className="h-1.5 w-1.5 rounded-full" style={{ background: PROVIDER_COLORS[r.provider] }} /><span className="truncate">{r.name}</span></span>
            <span className="font-medium text-white">{pct(r.cpu)}</span>
          </div>
          <ProgressBar value={r.cpu} color={r.cpu > 85 ? '#ef4444' : '#3b82f6'} height={5} />
        </div>
      ))}
    </div>
  );
}

/** Automation Workflows widget — workflows, triggers, runs and status. */
function AutomationWidget() {
  const { data } = useCommandCenter();
  const rows = data?.workflows ?? [];
  if (rows.length === 0) return <div className="py-6 text-center text-2xs text-muted">No automation workflows yet.</div>;
  return (
    <div className="divide-y divide-border-soft">
      {rows.map((w) => (
        <div key={w.id} className="flex items-center justify-between gap-2 py-2 text-2xs">
          <div className="min-w-0"><div className="truncate text-white">{w.name}</div><div className="text-muted">Trigger: {w.trigger}</div></div>
          <div className="flex shrink-0 items-center gap-2"><span className="text-muted">{number(w.runs)} runs</span><span className="rounded px-1.5 py-0.5" style={{ background: `${STATUS_COLORS[w.status] ?? '#22c55e'}22`, color: STATUS_COLORS[w.status] ?? '#22c55e' }}>{w.status}</span></div>
        </div>
      ))}
    </div>
  );
}

/** Guest Agents widget — online status + CPU/mem/disk telemetry per agent host. */
function GuestAgents({ scope = 'all', onConfig }: { scope?: string; onConfig?: (patch: { group?: string }) => void }) {
  const { data } = useAgents();
  const update = useUpdateAgent();
  const all = (data ?? []).filter((a) => a.active);
  const groups = [...new Set(all.map((a) => a.group || 'default'))].sort();
  const agents = scope === 'all' ? all : all.filter((a) => (a.group || 'default') === scope);
  const online = agents.filter((a) => a.online).length;
  const [editId, setEditId] = useState<string | null>(null);
  const [g, setG] = useState('');
  const saveGroup = (id: string) => { update.mutate({ id, group: g.trim() || 'default' }); setEditId(null); };
  const mColor = (v: number | null) => (v == null ? '#64748b' : v >= 90 ? '#ef4444' : v >= 70 ? '#f59e0b' : '#22c55e');
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-2xs text-muted">
        <span>{agents.length} agent(s) · <span className="text-success">{online} online</span> · {agents.length - online} offline</span>
        {onConfig && groups.length > 0 && (
          <label className="flex items-center gap-1 rounded-md border border-border bg-bg pl-1.5" title="Filter by scope / group (shared with IP/Host Monitor & Network Devices)"><span className="text-[10px] opacity-70">⊟</span>
            <select value={scope} onChange={(e) => onConfig({ group: e.target.value })} className="cursor-pointer rounded-md bg-transparent py-1 pr-1 text-2xs text-white focus:outline-none">
              <option value="all">All scopes</option>
              {groups.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        )}
      </div>
      {agents.length === 0 ? (
        <div className="py-8 text-center text-2xs text-muted">{all.length === 0 ? 'No guest agents yet. Add one in Command Center → Guest Agents.' : `No agents in scope "${scope}".`}</div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => {
            const vmName = a.displayName || a.machineName || a.name || a.hostname || '—';
            const sub = a.hostname && a.hostname !== vmName ? a.hostname : (a.ips?.[0] ?? '');
            return (
              <div key={a.id} className="flex flex-col rounded-lg border border-border bg-card/60 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.online ? '#22c55e' : '#64748b' }} title={a.online ? 'online' : 'offline'} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white" title={vmName}>{vmName}</div>
                      <div className="truncate text-2xs text-muted">{sub && <span className="font-mono">{sub} · </span>}{a.os ?? '—'} · {a.mode === 'ssh-pull' ? 'SSH' : 'agent'}</div>
                    </div>
                  </div>
                  {editId === a.id ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <input autoFocus value={g} onChange={(e) => setG(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveGroup(a.id); if (e.key === 'Escape') setEditId(null); }} list="ga-groups" placeholder="group" className="w-20 rounded border border-border bg-bg px-1 py-0.5 text-2xs text-white focus:border-brand focus:outline-none" />
                      <button onClick={() => saveGroup(a.id)} className="text-brand" title="Save">✓</button>
                    </span>
                  ) : (
                    <button onClick={() => { setG(a.group || 'default'); setEditId(a.id); }} className="shrink-0 rounded-full border border-border bg-bg px-2 py-0.5 text-2xs text-muted-light hover:border-brand/50 hover:text-white" title="Change group / scope — moves this agent AND its monitor to the scope (shared with IP/Host Monitor & Network Devices)">⊟ {a.group || 'default'} ✎</button>
                  )}
                </div>
                <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                  {([['CPU', a.cpuPct], ['Mem', a.memPct], ['Disk', a.diskPct]] as const).map(([l, v]) => (
                    <div key={l} className="rounded-md border border-border-soft bg-bg/40 py-1.5 text-center">
                      <div className="text-sm font-semibold tabular-nums" style={{ color: mColor(v) }}>{v != null ? pct(v) : '—'}</div>
                      <div className="text-[10px] text-muted">{l}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-right text-2xs text-muted">{a.lastSeenAt ? `seen ${timeAgo(a.lastSeenAt)}` : 'never seen'}</div>
              </div>
            );
          })}
          <datalist id="ga-groups">{groups.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
      )}
    </div>
  );
}

function Health() {
  const { data } = useMonitoring();
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {(data?.serviceHealth ?? []).map((s) => (
        <div key={`${s.provider}-${s.service}`} className="rounded border border-border bg-card-hover/40 p-1.5">
          <div className="flex items-center justify-between">
            <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[s.health] }} />
            <span className="text-2xs" style={{ color: PROVIDER_COLORS[s.provider] }}>{PROVIDER_LABELS[s.provider]}</span>
          </div>
          <div className="mt-1 truncate text-2xs text-white">{s.service}</div>
        </div>
      ))}
    </div>
  );
}

const EVENT_SEV: Record<string, string> = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };

function EvtTag({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-2xs">
      <span className="text-muted">{label}</span>
      <span className="font-medium" style={{ color: color ?? '#e2e8f0' }}>{value}</span>
    </span>
  );
}

/** System Event Log — click a row to expand the exact log detail. */
function Events() {
  const { data } = useSystemEvents();
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const events = (data ?? []).slice(0, 50);
  if (events.length === 0) return <div className="py-6 text-center text-2xs text-muted">No events recorded yet.</div>;

  const copy = async (id: string, text: string) => {
    await copyText(text);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  };

  return (
    <div className="divide-y divide-border-soft">
      {events.map((e) => {
        const c = EVENT_SEV[e.severity] ?? '#64748b';
        const open = openId === e.id;
        return (
          <div key={e.id}>
            <button onClick={() => setOpenId(open ? null : e.id)} className="flex w-full items-start gap-2 py-1.5 pr-1 text-left hover:bg-card-hover">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: c }} title={e.severity} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-2xs text-white">{e.title}</span>
                <span className="block text-2xs text-muted">{e.type} · {timeAgo(e.ts)}{e.resourceName ? ` · ${e.resourceName}` : ''}</span>
              </span>
              <span className="mt-0.5 shrink-0 text-2xs text-muted">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              <div className="space-y-2 border-t border-border-soft bg-bg/40 px-3 py-2">
                <div className="flex flex-wrap gap-1.5">
                  <EvtTag label="severity" value={e.severity} color={c} />
                  <EvtTag label="type" value={e.type} />
                  {e.provider && <EvtTag label="provider" value={PROVIDER_LABELS[e.provider] ?? e.provider} color={PROVIDER_COLORS[e.provider]} />}
                  {e.resourceName && <EvtTag label="resource" value={e.resourceName} />}
                  <EvtTag label="time" value={new Date(e.ts).toLocaleString()} />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-2xs font-semibold uppercase tracking-wide text-muted">Detail</span>
                    {e.detail && <button onClick={() => copy(e.id, `${e.title}\n${new Date(e.ts).toISOString()}\n\n${e.detail}`)} className="text-2xs text-brand hover:underline">{copied === e.id ? 'copied ✓' : 'copy'}</button>}
                  </div>
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-2 font-mono text-2xs leading-relaxed text-muted-light">{e.detail || 'No additional detail recorded for this event.'}</pre>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DatasetCat({ dataset, chart, money: isMoney }: { dataset: string; chart?: string; money?: boolean }) {
  const { data } = useDatasets();
  const ds = (data ?? []).find((d) => d.key === dataset);
  return <CategoryRender data={ds?.data ?? []} chart={chart} fmt={isMoney ? (n) => number(n) : undefined} />;
}
