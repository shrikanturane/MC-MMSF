export type Provider = 'aws' | 'azure' | 'gcp' | 'private' | 'docker' | 'linux' | 'windows' | 'vmware' | 'esxi' | 'nutanix' | 'proxmox' | 'kvm';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export const PROVIDER_LABELS: Record<Provider, string> = {
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'GCP',
  private: 'Private Cloud',
  docker: 'Docker',
  linux: 'Linux',
  windows: 'Windows',
  vmware: 'VMware',
  esxi: 'ESXi',
  nutanix: 'Nutanix',
  proxmox: 'Proxmox VE',
  kvm: 'KVM',
};

export const PROVIDER_COLORS: Record<Provider, string> = {
  aws: '#ff9900',
  azure: '#0078d4',
  gcp: '#ea4335',
  private: '#a855f7',
  docker: '#2496ed',
  linux: '#f59e0b',
  windows: '#00a4ef',
  vmware: '#607078',
  esxi: '#717074',
  nutanix: '#024da1',
  proxmox: '#e57000',
  kvm: '#16a34a',
};

export const SEVERITY_COLORS: Record<Severity, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#f59e0b',
  low: '#3b82f6',
};

export const STATUS_COLORS: Record<string, string> = {
  running: '#22c55e',
  connected: '#22c55e',
  healthy: '#22c55e',
  active: '#22c55e',
  enabled: '#22c55e',
  degraded: '#f59e0b',
  warning: '#f59e0b',
  investigating: '#f59e0b',
  acknowledged: '#f59e0b',
  pending: '#f59e0b',
  stopped: '#64748b',
  disconnected: '#64748b',
  resolved: '#64748b',
  down: '#ef4444',
  error: '#ef4444',
  open: '#ef4444',
  terminated: '#ef4444',
};

/** Currency-aware money formatter (₹ / $ / € …) using the connection's reported currency. */
export function money(amount: number, code = 'USD', compact = false): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : 0,
    }).format(amount);
  } catch {
    return `${code} ${Math.round(amount).toLocaleString()}`;
  }
}

export function currency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

export function number(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function pct(n: number): string {
  return `${Math.round(n)}%`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
