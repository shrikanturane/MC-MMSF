import { ResourceType } from '@prisma/client';
import type { DiscoveredAsset } from './adapter';

/**
 * Map a provider-native resource-type hint to this app's canonical ResourceType enum.
 * Azure assets carry the full ARM type (e.g. "Microsoft.Compute/virtualMachines") in
 * properties.azureType — we match on that first for accuracy, then fall back to keyword rules.
 */
export function mapResourceType(hint: string, azureType?: string): ResourceType {
  const t = (azureType ?? hint).toLowerCase();

  // Azure ARM namespace-aware mapping (most accurate).
  if (azureType) {
    if (t.includes('/virtualmachines') && !t.includes('/extensions')) return ResourceType.compute;
    if (t.includes('microsoft.compute/disks') || t.includes('/snapshots')) return ResourceType.storage;
    if (t.includes('microsoft.storage/')) return ResourceType.storage;
    if (t.includes('microsoft.network/')) return ResourceType.network;
    if (t.includes('microsoft.sql/') || t.includes('microsoft.dbfor') || t.includes('/cosmosdb')) return ResourceType.database;
    if (t.includes('microsoft.containerservice/') || t.includes('/managedclusters') || t.includes('containerinstance')) return ResourceType.container;
    if (t.includes('microsoft.web/sites') || t.includes('/serverfarms') || t.includes('microsoft.functions')) return ResourceType.serverless;
    if (t.includes('microsoft.keyvault/') || t.includes('microsoft.security/') || t.includes('/networksecuritygroups')) {
      return t.includes('/networksecuritygroups') ? ResourceType.network : ResourceType.security;
    }
    if (t.includes('microsoft.purview/') || t.includes('microsoft.synapse/') || t.includes('microsoft.datafactory/') || t.includes('/bigdata')) return ResourceType.analytics;
    if (t.includes('/extensions') || t.includes('microsoft.devtestlab/') || t.includes('/schedules') || t.includes('microsoft.insights/')) return ResourceType.other;
    // fall through to keyword rules for anything else
  }

  if (t.includes('database') || t.includes('sql') || t.includes('rds') || t.includes('cosmos') || t.includes('cloudsql')) return ResourceType.database;
  if (t.includes('networksecuritygroup') || t.includes('network') || t.includes('vnet') || t.includes('vpc') || t.includes('subnet') || t.includes('loadbalancer') || t.includes('gateway') || t.includes('publicip') || t.includes('networkinterface')) return ResourceType.network;
  if (t.includes('storage') || t.includes('bucket') || t.includes('blob') || t.includes('disk') || t.includes('s3')) return ResourceType.storage;
  if (t.includes('container') || t.includes('aks') || t.includes('eks') || t.includes('gke') || t.includes('kubernetes')) return ResourceType.container;
  if (t.includes('function') || t.includes('lambda') || t.includes('serverless')) return ResourceType.serverless;
  if (t.includes('keyvault') || t.includes('firewall') || t.includes('guardduty') || t.includes('security')) return ResourceType.security;
  if (t.includes('analytics') || t.includes('bigquery') || t.includes('synapse') || t.includes('athena') || t.includes('purview')) return ResourceType.analytics;
  if (t.includes('vm') || t.includes('instance') || t.includes('compute') || t.includes('virtualmachine')) return ResourceType.compute;
  return azureType ? ResourceType.other : ResourceType.compute;
}

const PROVIDER_LABELS: Record<string, string> = {
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'GCP',
  docker: 'Docker',
  linux: 'Linux Host',
  windows: 'Windows Host',
  private: 'Private Cloud',
  vmware: 'VMware',
  esxi: 'ESXi',
  nutanix: 'Nutanix',
  proxmox: 'Proxmox VE',
  kvm: 'KVM',
};

/** Derive a short service label from the discovered asset / provider. */
export function deriveService(provider: string, asset: DiscoveredAsset): string {
  const azureType = typeof asset.properties.azureType === 'string' ? asset.properties.azureType : undefined;
  if (azureType) {
    // "Microsoft.Compute/virtualMachines" → "Compute / virtualMachines"
    const parts = azureType.split('/');
    const ns = parts[0]?.replace(/^Microsoft\./, '') ?? '';
    const kind = parts.slice(1).join('/');
    return [ns, kind].filter(Boolean).join(' / ') || PROVIDER_LABELS[provider] || provider;
  }
  const t = asset.resourceType.split(':')[0];
  return t ? `${PROVIDER_LABELS[provider] ?? provider} ${t}`.trim() : PROVIDER_LABELS[provider] ?? provider;
}
