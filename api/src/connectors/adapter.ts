/**
 * Cloud provider adapter contract (ported from the proven monorepo connectors).
 * Each provider implements this; the domain stays provider-neutral. Adapters normalize
 * provider-native resources into the canonical DiscoveredAsset shape the inventory understands.
 */

export interface DiscoveredAsset {
  resourceType: string; // canonical-ish hint, e.g. "compute:instance", "vm", "storage:bucket"
  externalId: string;
  name: string;
  region: string;
  monthlyCost?: number;
  cpuPct?: number;
  memoryPct?: number;
  properties: Record<string, unknown>;
}

export interface CloudAccountRef {
  externalAccountId: string;
}

/** Decrypted provider credentials, supplied per connection (never from shared env in prod). */
export interface ProviderCredentials {
  // aws
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  endpoint?: string;
  // azure
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  subscriptionId?: string;
  // gcp
  accessToken?: string;
  serviceAccountKey?: string; // full Service Account JSON key
  project?: string;
  orgId?: string; // GCP organisation id (for Security Command Center)
  billingTable?: string; // GCP BigQuery billing export table (project.dataset.table) for cost
  // docker
  socketPath?: string;
  host?: string;
  // ssh (linux/windows)
  port?: string;
  username?: string;
  password?: string;
  privateKey?: string;
  [key: string]: string | undefined;
}

/** One step of a staged connection test, so the UI can show exactly where it fails. */
export interface TestStage {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
  optional?: boolean; // failure is a warning, not a connection failure
}

export interface TestResult {
  ok: boolean;
  stages: TestStage[];
  detail: string;
}

/** Drop blank/whitespace credential fields so empty form inputs never reach an SDK. */
export function cleanCreds(c: Record<string, string | undefined>): ProviderCredentials {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v != null && String(v).trim() !== '') out[k] = String(v).trim();
  }
  return out;
}

/**
 * MCMF-provisioned resources are recorded with an internal `provisioned:<provider>:<type>:`
 * prefix on their externalId. Cloud APIs need the REAL id, so strip that prefix at the boundary.
 * Discovered resources have no prefix and pass through unchanged.
 */
export function cloudId(externalId: string): string {
  return (externalId || '').replace(/^provisioned:[^:]+:[^:]+:/, '');
}

export type PowerAction = 'start' | 'stop' | 'reboot';

/** Context a connector needs to act on a single VM. */
export interface ControlContext {
  externalId: string; // provider id (Azure resourceId / AWS i-… / GCP numeric id / docker:<id>)
  name: string;
  region: string;
  zone?: string;
  mac?: string; // NIC MAC — used for Wake-on-LAN power-on of SSH hosts on the same LAN
}

/** A normalized cloud security finding (Defender / Security Hub / GuardDuty / SCC). */
export interface DiscoveredFinding {
  externalId: string;
  title: string;
  type: 'vulnerability' | 'misconfiguration' | 'threat';
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'investigating' | 'resolved';
  source: string;
  resourceName?: string;
  detectedAt?: string;
}

/** Month-to-date cost summary for a connection. */
export interface CostSummary {
  total: number;
  currency: string;
  byService: { service: string; cost: number }[];
  /** The billing table actually used (set when auto-detected) so the caller can persist it. */
  usedTable?: string;
}

/** Regulatory-compliance standard score (CIS / ISO 27001 / PCI DSS …). */
export interface ComplianceStandard {
  name: string;
  score: number; // 0-100
  passed: number;
  failed: number;
}

export interface CloudConnector {
  readonly provider: string;
  /** List & normalize the resources visible in the connection, using its credentials. */
  discover(account: CloudAccountRef, credentials: ProviderCredentials): Promise<DiscoveredAsset[]>;
  /** Staged credential/reachability check — returns each phase with pass/fail. */
  test(credentials: ProviderCredentials): Promise<TestResult>;
  /** Power action on a VM (start/stop/reboot). Optional — only cloud VM providers implement it. */
  control?(action: PowerAction, ctx: ControlContext, credentials: ProviderCredentials): Promise<{ ok: boolean; detail: string }>;
  /** Pull cloud security findings (Defender / Security Hub / SCC). Optional. */
  getFindings?(credentials: ProviderCredentials): Promise<DiscoveredFinding[]>;
  /** Month-to-date cost by service (Cost Management / Cost Explorer). Optional. */
  getCost?(credentials: ProviderCredentials): Promise<CostSummary | null>;
  /** Regulatory compliance standards (Defender / Audit Manager / SCC). Optional. */
  getCompliance?(credentials: ProviderCredentials): Promise<ComplianceStandard[]>;
  /** Network/firewall rules (NSG / Security Group / firewall) for exposure analysis. Optional. */
  getNetworkRules?(credentials: ProviderCredentials): Promise<NetworkRule[]>;
  /** Remediate a risky rule (deny / revoke / disable). Reversible. Optional. */
  remediateRule?(credentials: ProviderCredentials, target: NetworkRuleTarget): Promise<{ ok: boolean; detail: string }>;
  /** Create a resource (network / vm / disk). Billed & live — gated by PROVISION_EXEC. Optional. */
  provision?(credentials: ProviderCredentials, spec: ProvisionSpec): Promise<ProvisionResult>;
  /** Delete a provisioned VM (and its MCMF-created firewall/NIC/IP). Approval-gated. Optional. */
  deprovision?(credentials: ProviderCredentials, spec: ProvisionSpec): Promise<ProvisionResult>;
  /** Live option pools for the provisioning form (regions, resource groups, networks, subnets, images). Optional. */
  listProvisionOptions?(credentials: ProviderCredentials, region?: string): Promise<ProvisionOptions>;
  /** Non-secret identity of the connection (account/SP/SA) used to pre-fill grant scripts. Optional. */
  identity?(credentials: ProviderCredentials): Promise<ProvisionIdentity>;
  /** Non-destructive check that the connection can create networks (DryRun / permissions). Optional. */
  testProvision?(credentials: ProviderCredentials): Promise<{ ready: boolean; detail: string }>;
}

/** Non-secret identifiers used to pre-populate the permission-grant scripts. */
export interface ProvisionIdentity {
  account?: string; // aws account id
  principal?: string; // aws iam user name
  region?: string; // aws default region
  subscriptionId?: string; // azure
  clientId?: string; // azure app registration
  project?: string; // gcp
  serviceAccountEmail?: string; // gcp
}

/** Auto-populate pools for the provisioning form, fetched from the live cloud. */
export interface ProvisionOptions {
  regions?: { value: string; label: string }[];
  resourceGroups?: { value: string; label: string }[];
  networks?: { value: string; label: string; region?: string; subnets?: string[] }[];
  zones?: { value: string; label: string }[];
  subnets?: { value: string; label: string }[]; // aws subnet ids
  images?: { value: string; label: string }[]; // aws AMI ids / latest images
}

/** A request to create a cloud resource. */
export interface ProvisionSpec {
  kind: 'network' | 'vm' | 'disk';
  name: string;
  region?: string;
  cidr?: string; // network
  subnetCidr?: string; // network
  resourceGroup?: string; // azure
  size?: string; // azure vm
  os?: string; // vm
  sizeGb?: number; // disk
  image?: string; // vm image / AMI / source image
  network?: string; // vm: vnet / vpc network name
  subnet?: string; // vm: subnet name/id
  adminUsername?: string; // vm
  adminPassword?: string; // vm
  osDiskSizeGb?: number; // azure vm os disk
  zone?: string; // gcp vm zone
  machineType?: string; // gcp vm
  instanceType?: string; // aws vm
  ami?: string; // aws vm
  keyPair?: string; // aws vm
  subnetId?: string; // aws vm
  volumeSizeGb?: number; // aws vm root vol
  diskSizeGb?: number; // gcp vm boot disk
  sku?: string; // azure disk
  volumeType?: string; // aws disk
  type?: string; // gcp disk type
  availabilityZone?: string; // aws disk
  consolePorts?: string[] | string; // vm: inbound ports to open for console (e.g. ['22','3389'])
  sourceCidrs?: string; // vm: comma-separated CIDRs allowed to those ports (MCMF server + admin IP)
  sshPublicKey?: string; // vm: when set, inject this OpenSSH public key for the admin user (key-auth)
  [key: string]: unknown; // tolerate extra form fields
}

export interface ProvisionResult {
  ok: boolean;
  detail: string;
  externalId?: string;
  publicIp?: string; // vm: the new VM's public IP (so creds can be vaulted for the console)
  consoleHint?: string; // vm: what console access was set up (ports/source), surfaced to the user
}

/** Thrown by connector.provision() so the approval can record which phase failed + the fix. */
export class ProvisionError extends Error {
  constructor(message: string, public readonly phase: string, public readonly remediation: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/** Identifies a specific rule to remediate (from a NetworkRisk). */
export interface NetworkRuleTarget {
  resourceName: string;
  ruleName: string;
  source: string;
  ports: string;
  protocol: string;
}

/** A normalized firewall/NSG rule across clouds. */
export interface NetworkRule {
  resourceName: string; // NSG / security group / firewall name
  ruleName: string;
  direction: 'inbound' | 'outbound';
  access: 'allow' | 'deny';
  protocol: string; // tcp | udp | * | all
  source: string; // CIDR or tag, e.g. 0.0.0.0/0, Internet, *
  ports: string; // e.g. "22", "3389", "0-65535", "*"
  priority?: number;
}

/** Run named stages in order, stopping at the first failure (rest marked skipped). */
export async function runStages(
  stages: { name: string; run: () => Promise<string>; optional?: boolean }[],
  successDetail = 'All checks passed',
): Promise<TestResult> {
  const results: TestStage[] = [];
  let failed = false; // a CRITICAL stage failed
  let warned = false; // an OPTIONAL stage failed
  let failDetail = '';
  for (const s of stages) {
    if (failed) {
      results.push({ name: s.name, ok: false, detail: 'skipped', skipped: true });
      continue;
    }
    try {
      const detail = await s.run();
      results.push({ name: s.name, ok: true, detail });
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      if (s.optional) {
        // Non-blocking: record the warning but keep going and stay overall-OK.
        results.push({ name: s.name, ok: false, detail, optional: true });
        warned = true;
      } else {
        results.push({ name: s.name, ok: false, detail });
        failed = true;
        failDetail = `${s.name} failed: ${detail}`;
      }
    }
  }
  const detail = failed
    ? failDetail
    : warned
      ? `${successDetail} — some optional checks were skipped (see warnings)`
      : successDetail;
  return { ok: !failed, stages: results, detail };
}
