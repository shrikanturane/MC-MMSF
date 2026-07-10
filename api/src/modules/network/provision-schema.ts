/**
 * Cloud-aware provisioning schemas. Each (provider, kind) lists every field the
 * cloud requires to deploy the resource, with auto-populated option pools
 * (regions / resource-groups / networks injected live where possible) and
 * "+ Create new" support on selects that can spawn a dependency (group/network).
 */

export interface ProvOption { value: string; label: string }
export interface ProvField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'password' | 'note';
  required?: boolean;
  options?: ProvOption[];
  allowNew?: boolean; // select can create a brand-new value (e.g. resource group / network)
  newLabel?: string; // label for the "+ Create new" option
  default?: string;
  placeholder?: string;
  help?: string;
  pattern?: string; // client-side validation regex (string form)
  patternHint?: string; // message shown when the pattern fails
}
export interface ProvSchema {
  provider: string;
  kind: string;
  title: string;
  executable: boolean; // live deploy is implemented for this provider+kind
  fields: ProvField[];
}

/** Dynamic option pools fetched from the live cloud (best-effort). */
export interface ProvDynamic {
  regions?: ProvOption[];
  resourceGroups?: ProvOption[];
  networks?: (ProvOption & { region?: string; subnets?: string[] })[];
  zones?: ProvOption[];
  subnets?: ProvOption[];
  images?: ProvOption[];
  mcmfIp?: string; // this MCMF server's address — prefilled as an allowed console source
  adminIp?: string; // the requesting admin's IP — prefilled as an allowed console source
}

const opt = (vals: (string | [string, string])[]): ProvOption[] =>
  vals.map((v) => (Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: v }));

/**
 * Console-access fields shared by every cloud's VM form: which inbound ports to open and from where.
 * The source is prefilled with the MCMF server + the admin's IP (per the chosen security posture) so
 * the browser console works immediately while staying tightly scoped. Ports are left blank — the
 * operator picks explicitly (22 = SSH/Linux, 3389 = RDP/Windows).
 */
const consoleFields = (d: ProvDynamic): ProvField[] => {
  const src = [d.mcmfIp ? `${d.mcmfIp}/32` : '', d.adminIp && d.adminIp !== d.mcmfIp ? `${d.adminIp}/32` : ''].filter(Boolean).join(', ');
  return [
    { key: 'consolePorts', label: 'Console ports to open', type: 'text', placeholder: '22, 3389',
      help: 'Comma-separated inbound ports for SSH/RDP & the browser console. 22 = SSH (Linux), 3389 = RDP (Windows). Leave blank to open none.' },
    { key: 'sourceCidrs', label: 'Allow those ports from', type: 'text', default: src || '',
      placeholder: '203.0.113.10/32, YOUR_IP/32',
      help: 'Source IPs/CIDRs allowed to reach those ports. Prefilled with the MCMF server + your IP so the console connects. Use 0.0.0.0/0 for anywhere (not recommended — MCMF flags it).' },
    { key: 'keyAuth', label: 'Console auth (Linux)', type: 'select', default: 'password',
      options: [{ value: 'password', label: 'Password' }, { value: 'key', label: 'Generate + vault an SSH key' }],
      help: 'Password: vault the admin password. SSH key: MCMF generates a keypair, installs the public key on the VM, and vaults the private key — the console connects key-based, no password.' },
    { key: 'shareScope', label: 'Share the vaulted credential with', type: 'select', default: 'all',
      options: [{ value: 'all', label: 'All users' }, { value: 'selected', label: 'Selected users' }, { value: 'owner', label: 'Just me (owner only)' }],
      help: 'Who this VM’s console credential auto-fills for. The secret stays sealed in the vault; sharing only controls who may use it.' },
    { key: 'shareUsers', label: 'Selected users (emails)', type: 'text', placeholder: 'alice@org.com, bob@org.com',
      help: 'Only when “Selected users” is chosen — comma-separated emails of the users who may use the credential.' },
  ];
};

// ── Curated static catalogues (used when the cloud can't be queried live) ──
const AZURE_REGIONS = opt(['eastasia', 'southeastasia', 'eastus', 'eastus2', 'westus2', 'westeurope', 'northeurope', 'centralindia', 'southindia', 'uksouth', 'australiaeast']);
const AZURE_VM_SIZES = opt([
  ['Standard_B1s', 'B1s · 1 vCPU · 1 GB'],
  ['Standard_B2s', 'B2s · 2 vCPU · 4 GB'],
  ['Standard_B2ms', 'B2ms · 2 vCPU · 8 GB'],
  ['Standard_D2s_v3', 'D2s_v3 · 2 vCPU · 8 GB'],
  ['Standard_D4s_v3', 'D4s_v3 · 4 vCPU · 16 GB'],
  ['Standard_E2s_v3', 'E2s_v3 · 2 vCPU · 16 GB'],
]);
const AZURE_IMAGES = opt([
  ['Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest', 'Ubuntu Server 22.04 LTS'],
  ['Canonical:0001-com-ubuntu-server-focal:20_04-lts-gen2:latest', 'Ubuntu Server 20.04 LTS'],
  ['MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition:latest', 'Windows Server 2022 Datacenter'],
  ['RedHat:RHEL:9-lvm-gen2:latest', 'Red Hat Enterprise Linux 9'],
]);
const AZURE_DISK_SKUS = opt([['Standard_LRS', 'Standard HDD (LRS)'], ['StandardSSD_LRS', 'Standard SSD (LRS)'], ['Premium_LRS', 'Premium SSD (LRS)']]);

const AWS_REGIONS = opt(['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'eu-north-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1']);
const AWS_INSTANCE_TYPES = opt([
  ['t3.micro', 't3.micro · 2 vCPU · 1 GB'],
  ['t3.small', 't3.small · 2 vCPU · 2 GB'],
  ['t3.medium', 't3.medium · 2 vCPU · 4 GB'],
  ['t3.large', 't3.large · 2 vCPU · 8 GB'],
  ['m5.large', 'm5.large · 2 vCPU · 8 GB'],
  ['c5.large', 'c5.large · 2 vCPU · 4 GB'],
]);
const AWS_EBS_TYPES = opt([['gp3', 'General Purpose SSD (gp3)'], ['gp2', 'General Purpose SSD (gp2)'], ['io2', 'Provisioned IOPS (io2)'], ['st1', 'Throughput HDD (st1)']]);

const GCP_ZONES = opt(['us-central1-a', 'us-east1-b', 'us-west1-a', 'europe-west1-b', 'europe-west2-a', 'asia-southeast1-a', 'asia-south1-a', 'australia-southeast1-a']);
const GCP_REGIONS = opt(['us-central1', 'us-east1', 'us-west1', 'europe-west1', 'europe-west2', 'asia-southeast1', 'asia-south1', 'australia-southeast1']);
const GCP_MACHINE_TYPES = opt([
  ['e2-micro', 'e2-micro · 2 vCPU · 1 GB'],
  ['e2-small', 'e2-small · 2 vCPU · 2 GB'],
  ['e2-medium', 'e2-medium · 2 vCPU · 4 GB'],
  ['e2-standard-2', 'e2-standard-2 · 2 vCPU · 8 GB'],
  ['n2-standard-2', 'n2-standard-2 · 2 vCPU · 8 GB'],
]);
const GCP_IMAGES = opt([
  ['projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts', 'Ubuntu 22.04 LTS'],
  ['projects/debian-cloud/global/images/family/debian-12', 'Debian 12'],
  ['projects/windows-cloud/global/images/family/windows-2022', 'Windows Server 2022'],
]);
const GCP_DISK_TYPES = opt([['pd-standard', 'Standard persistent disk'], ['pd-balanced', 'Balanced persistent disk'], ['pd-ssd', 'SSD persistent disk']]);

const KIND_TITLE: Record<string, string> = { network: 'Network', vm: 'Virtual Machine', disk: 'Disk' };

// GCP resource names: lowercase letters/digits/hyphens, start with a letter, ≤ 62.
const GCP_NAME = { pattern: '^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$', patternHint: 'Lowercase letters, digits and hyphens; must start with a letter (e.g. app-server-1).' };
const AZURE_NAME = { pattern: '^[A-Za-z0-9][\\w.-]{0,78}[A-Za-z0-9]$', patternHint: 'Letters, digits, hyphens, dots or underscores; start and end alphanumeric.' };
const AWS_NAME = { pattern: '^[\\w .-]{1,255}$', patternHint: 'Letters, digits, spaces, dots, hyphens or underscores.' };
// Strong VM password — satisfies Azure's policy (12–72 chars, upper+lower+digit+symbol).
const PWD_RULE = { pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[^A-Za-z0-9]).{12,72}$', patternHint: '12–72 characters with an uppercase letter, lowercase letter, digit and symbol.' };

/** Build the field schema for a provider + kind, merging in any live option pools. */
export function buildProvisionSchema(provider: string, kind: string, dyn: ProvDynamic = {}): ProvSchema {
  const fields = FIELD_BUILDERS[`${provider}:${kind}`]?.(dyn) ?? genericFields(kind);
  // Live deploy is implemented for network, VM and disk creation on all three major clouds.
  const executable = ['network', 'vm', 'disk'].includes(kind) && ['azure', 'aws', 'gcp'].includes(provider);
  return { provider, kind, title: `${provider.toUpperCase()} · ${KIND_TITLE[kind] ?? kind}`, executable, fields };
}

/** Show existing networks (if any) so the user sees what's already deployed before adding one. */
const existingNetworksNote = (dyn: ProvDynamic): ProvField[] =>
  dyn.networks?.length
    ? [{ key: '_existing', label: `Existing networks: ${dyn.networks.map((n) => `${n.value}${n.region ? ` (${n.region})` : ''}`).join(', ')}`, type: 'note' as const }]
    : [];

const rgField = (dyn: ProvDynamic): ProvField => {
  // Always offer mcmf-provisioned FIRST and as the default — that's the RG the grant
  // script gives the app permission on, so deploys don't 403 in an unrelated group.
  const provided = dyn.resourceGroups ?? [];
  const hasMcmf = provided.some((g) => g.value === 'mcmf-provisioned');
  const options = hasMcmf ? provided : [{ value: 'mcmf-provisioned', label: 'mcmf-provisioned (recommended)' }, ...provided];
  return {
    key: 'resourceGroup',
    label: 'Resource group',
    type: 'select',
    required: true,
    options,
    allowNew: true,
    newLabel: '+ New resource group…',
    default: 'mcmf-provisioned',
    help: 'Defaults to mcmf-provisioned — the group the grant script authorizes the app on.',
  };
};
const azRegion = (dyn: ProvDynamic): ProvField => ({ key: 'region', label: 'Region', type: 'select', required: true, options: dyn.regions?.length ? dyn.regions : AZURE_REGIONS, default: 'eastasia' });

const FIELD_BUILDERS: Record<string, (dyn: ProvDynamic) => ProvField[]> = {
  // ── Azure ──
  'azure:network': (d) => [
    ...existingNetworksNote(d),
    rgField(d),
    azRegion(d),
    { key: 'name', label: 'Network name', type: 'text', required: true, placeholder: 'prod-vnet', ...AZURE_NAME },
    { key: 'cidr', label: 'Address space (CIDR)', type: 'text', required: true, default: '10.20.0.0/16' },
    { key: 'subnetCidr', label: 'Default subnet (CIDR)', type: 'text', default: '10.20.0.0/24', help: 'Must be within the address space.' },
  ],
  'azure:vm': (d) => [
    rgField(d),
    azRegion(d),
    { key: 'name', label: 'VM name', type: 'text', required: true, placeholder: 'app-server-1', ...AZURE_NAME },
    { key: 'size', label: 'Size', type: 'select', required: true, options: AZURE_VM_SIZES, default: 'Standard_B2s' },
    { key: 'image', label: 'OS image', type: 'select', required: true, options: AZURE_IMAGES },
    { key: 'network', label: 'Virtual network', type: 'select', required: true, options: d.networks ?? [], allowNew: true, newLabel: '+ New VNet…', help: 'Attach to an existing VNet or create one.' },
    { key: 'subnet', label: 'Subnet', type: 'text', required: true, default: 'default' },
    { key: 'adminUsername', label: 'Admin username', type: 'text', required: true, default: 'azureuser' },
    { key: 'adminPassword', label: 'Admin password', type: 'password', required: true, help: 'Windows: required. Linux: a password or SSH key.', ...PWD_RULE },
    { key: 'osDiskSizeGb', label: 'OS disk (GB)', type: 'number', default: '30' },
    ...consoleFields(d),
    { key: 'note', label: 'A public IP + NIC are created automatically; an NSG opens your chosen console ports from the allowed sources.', type: 'note' },
  ],
  'azure:disk': (d) => [
    rgField(d),
    azRegion(d),
    { key: 'name', label: 'Disk name', type: 'text', required: true, placeholder: 'data-disk-1', ...AZURE_NAME },
    { key: 'sizeGb', label: 'Size (GB)', type: 'number', required: true, default: '100' },
    { key: 'sku', label: 'Disk type', type: 'select', required: true, options: AZURE_DISK_SKUS, default: 'StandardSSD_LRS' },
  ],
  // ── AWS ──
  'aws:network': (d) => [
    ...existingNetworksNote(d),
    { key: 'region', label: 'Region', type: 'select', required: true, options: d.regions?.length ? d.regions : AWS_REGIONS, default: 'us-east-1' },
    { key: 'name', label: 'VPC name (tag)', type: 'text', required: true, placeholder: 'prod-vpc', ...AWS_NAME },
    { key: 'cidr', label: 'CIDR block', type: 'text', required: true, default: '10.30.0.0/16' },
    { key: 'subnetCidr', label: 'Default subnet (CIDR)', type: 'text', default: '10.30.0.0/24', help: 'Must fit inside the VPC CIDR.' },
  ],
  'aws:vm': (d) => [
    { key: 'region', label: 'Region', type: 'select', required: true, options: d.regions?.length ? d.regions : AWS_REGIONS, default: 'us-east-1', help: 'Subnets & images below are for this region.' },
    { key: 'name', label: 'Name (tag)', type: 'text', required: true, placeholder: 'app-server-1', ...AWS_NAME },
    { key: 'instanceType', label: 'Instance type', type: 'select', required: true, options: AWS_INSTANCE_TYPES, default: 't3.micro' },
    { key: 'ami', label: 'Image (AMI)', type: 'select', required: true, options: d.images ?? [], allowNew: true, newLabel: '+ Custom AMI id…', help: d.images?.length ? 'Latest images for the region — or enter a custom AMI id.' : 'Enter a region-specific AMI id (ami-…).' },
    { key: 'subnetId', label: 'Subnet', type: 'select', required: true, options: d.subnets ?? [], allowNew: true, newLabel: '+ Custom subnet id…', help: d.subnets?.length ? 'Auto-populated from the region.' : 'Enter a subnet id (subnet-…).' },
    { key: 'adminUsername', label: 'Admin username', type: 'text', required: true, default: 'ec2user' },
    { key: 'adminPassword', label: 'Admin password', type: 'password', required: true, help: 'Set via cloud-init; enables SSH password login.', ...PWD_RULE },
    { key: 'keyPair', label: 'Key pair (optional)', type: 'text', help: 'Existing EC2 key-pair name for key-based SSH (optional alongside the password).' },
    { key: 'volumeSizeGb', label: 'Root volume (GB)', type: 'number', default: '20' },
    ...consoleFields(d),
  ],
  'aws:disk': () => [
    { key: 'region', label: 'Region', type: 'select', required: true, options: AWS_REGIONS, default: 'us-east-1' },
    { key: 'availabilityZone', label: 'Availability zone', type: 'text', required: true, placeholder: 'us-east-1a' },
    { key: 'name', label: 'Name (tag)', type: 'text', required: true, placeholder: 'data-volume-1', ...AWS_NAME },
    { key: 'sizeGb', label: 'Size (GB)', type: 'number', required: true, default: '100' },
    { key: 'volumeType', label: 'Volume type', type: 'select', required: true, options: AWS_EBS_TYPES, default: 'gp3' },
  ],
  // ── GCP ──
  'gcp:network': (d) => [
    ...existingNetworksNote(d),
    { key: 'name', label: 'VPC name', type: 'text', required: true, placeholder: 'prod-vpc', help: 'Creates an auto-mode VPC (subnets in every region).', ...GCP_NAME },
    { key: 'region', label: 'Subnet region', type: 'select', required: true, options: d.regions?.length ? d.regions : GCP_REGIONS, default: 'us-central1' },
  ],
  'gcp:vm': (d) => [
    { key: 'zone', label: 'Zone', type: 'select', required: true, options: GCP_ZONES, default: 'us-central1-a' },
    { key: 'name', label: 'Instance name', type: 'text', required: true, placeholder: 'app-server-1', ...GCP_NAME },
    { key: 'machineType', label: 'Machine type', type: 'select', required: true, options: GCP_MACHINE_TYPES, default: 'e2-medium' },
    { key: 'image', label: 'Boot image', type: 'select', required: true, options: GCP_IMAGES },
    { key: 'network', label: 'VPC network', type: 'select', required: true, options: d.networks ?? [], allowNew: true, newLabel: '+ New VPC…', default: 'default', help: 'Existing VPC, or "default".' },
    { key: 'adminUsername', label: 'Admin username', type: 'text', required: true, default: 'gcpuser' },
    { key: 'adminPassword', label: 'Admin password', type: 'password', required: true, help: 'Set via startup-script; enables SSH password login.', ...PWD_RULE },
    { key: 'diskSizeGb', label: 'Boot disk (GB)', type: 'number', default: '20' },
    ...consoleFields(d),
  ],
  'gcp:disk': () => [
    { key: 'zone', label: 'Zone', type: 'select', required: true, options: GCP_ZONES, default: 'us-central1-a' },
    { key: 'name', label: 'Disk name', type: 'text', required: true, placeholder: 'data-disk-1', ...GCP_NAME },
    { key: 'sizeGb', label: 'Size (GB)', type: 'number', required: true, default: '100' },
    { key: 'type', label: 'Disk type', type: 'select', required: true, options: GCP_DISK_TYPES, default: 'pd-balanced' },
  ],
};

function genericFields(kind: string): ProvField[] {
  const base: ProvField[] = [
    { key: 'region', label: 'Region', type: 'text', required: true },
    { key: 'name', label: 'Name', type: 'text', required: true },
  ];
  if (kind === 'network') base.push({ key: 'cidr', label: 'CIDR', type: 'text', required: true, default: '10.20.0.0/16' });
  if (kind === 'disk') base.push({ key: 'sizeGb', label: 'Size (GB)', type: 'number', required: true, default: '100' });
  return base;
}
