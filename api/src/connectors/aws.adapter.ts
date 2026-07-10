import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  DescribeVpnConnectionsCommand,
  CreateVpnGatewayCommand,
  AttachVpnGatewayCommand,
  CreateCustomerGatewayCommand,
  CreateVpnConnectionCommand,
  CreateVpnConnectionRouteCommand,
  DeleteVpnConnectionCommand,
  DeleteCustomerGatewayCommand,
  DetachVpnGatewayCommand,
  DeleteVpnGatewayCommand,
  DescribeSubnetsCommand,
  DescribeImagesCommand,
  RevokeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  TerminateInstancesCommand,
  CreateVpcCommand,
  CreateSubnetCommand,
  RunInstancesCommand,
  CreateVolumeCommand,
} from '@aws-sdk/client-ec2';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SecurityHubClient, GetFindingsCommand } from '@aws-sdk/client-securityhub';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import type { CloudAccountRef, CloudConnector, ControlContext, CostSummary, DiscoveredAsset, DiscoveredFinding, NetworkRule, NetworkRuleTarget, PowerAction, ProviderCredentials, ProvisionIdentity, ProvisionOptions, ProvisionResult, ProvisionSpec, TestResult } from './adapter';
import { runStages, ProvisionError, cloudId } from './adapter';
import { awsOsVersion } from './os-version';

/** Map an AWS SDK error to a phase-tagged ProvisionError with an actionable remediation. */
function awsProvisionError(phase: string, err: any): ProvisionError {
  const name = err?.name ?? '';
  const code = err?.$metadata?.httpStatusCode;
  const msg = (err?.message ?? String(err)).slice(0, 240);
  let remediation = 'Check the IAM policy and inputs, then retry — no re-approval needed.';
  if (name === 'UnauthorizedOperation' || code === 403) {
    remediation = /volume/i.test(phase)
      ? 'Attach an IAM policy allowing ec2:CreateVolume (+ ec2:CreateTags) to the connection user, then retry — no re-approval needed.'
      : /instance/i.test(phase)
        ? 'Attach an IAM policy allowing ec2:RunInstances (+ iam:PassRole if using an instance profile) to the connection user, then retry — no re-approval needed.'
        : 'Attach an IAM policy allowing ec2:CreateVpc, ec2:CreateSubnet and ec2:CreateTags to the connection user, then retry — no re-approval needed.';
  } else if (/VcpuLimitExceeded|InstanceLimitExceeded|MaxSpotInstanceCountExceeded|Unsupported.*quota/i.test(name + msg)) {
    remediation = 'An EC2 quota was exceeded (On-Demand vCPUs or instance count) in this region — request a Service Quotas increase (Console → Service Quotas → Amazon EC2), or pick a smaller instance type / a different region, then click ↻ Retry deploy — no re-approval needed.';
  } else if (name === 'VpcLimitExceeded' || name === 'AddressLimitExceeded' || /LimitExceeded/i.test(name)) {
    remediation = 'A regional AWS limit was reached (e.g. VPCs or Elastic IPs) — delete an unused one or request a quota increase, then click ↻ Retry deploy — no re-approval needed.';
  } else if (name === 'OptInRequired' || /not subscribed|not been signed up|billing/i.test(msg)) {
    remediation = 'This AWS account/region is not activated for the service (often billing/payment is not set up) — add a payment method / activate the region in the AWS Console, then click ↻ Retry deploy — no re-approval needed.';
  } else if (/Cidr|InvalidVpc\.Range|InvalidSubnet\.Range|InvalidParameterValue/i.test(name + msg)) {
    remediation = 'Fix the CIDR (VPC /16–/28; subnet must fit inside the VPC range), then retry.';
  }
  return new ProvisionError(`${phase}: ${name || code || 'error'} — ${msg}`, phase, remediation);
}

/** Carve a /24 default subnet from a VPC CIDR (or use it as-is when already ≤ /24). */
function awsDefaultSubnet(cidr: string): string {
  const [ip, lenStr] = cidr.split('/');
  const len = Number(lenStr);
  if (!ip || !Number.isFinite(len)) return '10.30.0.0/24';
  return len >= 24 ? cidr : `${ip}/24`;
}

const AWS_SEV: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFORMATIONAL: 'low',
};

/**
 * Real AWS connector (ported from the monorepo adapter, extended with S3 + STS test).
 * EC2 DescribeInstances + RDS DescribeDBInstances + S3 ListBuckets, normalized to DiscoveredAsset.
 * AWS_ENDPOINT_URL (or creds.endpoint) lets the exact same adapter run against LocalStack.
 */
export class AwsConnector implements CloudConnector {
  readonly provider = 'aws';
  private creds: ProviderCredentials = {};

  private get region(): string {
    // Empty-safe: a blank region must NOT pass through (it yields an invalid
    // endpoint like sts.global.amazonaws.com). Default to us-east-1.
    return (this.creds.region || '').trim() || (process.env.AWS_REGION || '').trim() || 'us-east-1';
  }

  private clientConfig(region?: string) {
    const endpoint = (this.creds.endpoint || process.env.AWS_ENDPOINT_URL || '').trim() || undefined;
    const cfg: any = { region: region ?? this.region };
    if (endpoint) cfg.endpoint = endpoint;
    if (this.creds.accessKeyId && this.creds.secretAccessKey) {
      cfg.credentials = {
        accessKeyId: this.creds.accessKeyId,
        secretAccessKey: this.creds.secretAccessKey,
        ...(this.creds.sessionToken ? { sessionToken: this.creds.sessionToken } : {}),
      };
    }
    return cfg;
  }

  /** Enabled regions to scan. A custom endpoint (LocalStack) → just the configured region. */
  private async listRegions(): Promise<string[]> {
    if ((this.creds.endpoint || process.env.AWS_ENDPOINT_URL || '').trim()) return [this.region];
    try {
      const ec2 = new EC2Client(this.clientConfig());
      const res = await ec2.send(new DescribeRegionsCommand({}));
      const names = (res.Regions ?? []).map((r) => r.RegionName).filter((x): x is string => Boolean(x));
      return names.length ? names : [this.region];
    } catch {
      return [this.region];
    }
  }

  async test(credentials: ProviderCredentials): Promise<TestResult> {
    this.creds = credentials;
    return runStages([
      {
        name: 'Authenticate (STS GetCallerIdentity)',
        run: async () => {
          const sts = new STSClient(this.clientConfig());
          const id = await sts.send(new GetCallerIdentityCommand({}));
          return `Authenticated as ${id.Arn ?? id.UserId ?? 'unknown'} (account ${id.Account ?? '?'})`;
        },
      },
      {
        name: 'List EC2 instances (ec2:DescribeInstances)',
        run: async () => {
          const ec2 = new EC2Client(this.clientConfig());
          const res = await ec2.send(new DescribeInstancesCommand({ MaxResults: 5 }));
          const n = (res.Reservations ?? []).reduce((s, r) => s + (r.Instances?.length ?? 0), 0);
          return `EC2 read OK (${n} instance(s) in this page)`;
        },
      },
      {
        name: 'List S3 buckets (s3:ListAllMyBuckets)',
        optional: true, // storage is a bonus; a boundary blocking S3 must not fail the connection
        run: async () => {
          const s3 = new S3Client(this.clientConfig());
          const res = await s3.send(new ListBucketsCommand({}));
          return `S3 read OK (${res.Buckets?.length ?? 0} bucket(s))`;
        },
      },
      {
        // Billing / account state — parity with GCP's billing stage. Optional so a billing
        // boundary NEVER fails the connection (billing is a Cloud Connections concern, not a
        // gate on connectivity). Probes Cost Explorer so the user sees, right here, WHY AWS
        // cost is (or isn't) flowing into FinOps.
        name: 'Billing / account state (Cost Explorer)',
        optional: true,
        run: async () => {
          const cfg = this.clientConfig('us-east-1'); // Cost Explorer is global (us-east-1)
          const ce = new CostExplorerClient(cfg);
          const now = new Date();
          const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
          const end = new Date(now.getTime() + 86400_000).toISOString().slice(0, 10);
          try {
            const res = await ce.send(
              new GetCostAndUsageCommand({
                TimePeriod: { Start: start, End: end },
                Granularity: 'MONTHLY',
                Metrics: ['UnblendedCost'],
              }),
            );
            let total = 0;
            let currency = 'USD';
            for (const t of res.ResultsByTime ?? []) {
              const m = t.Total?.UnblendedCost;
              total += Number(m?.Amount ?? 0);
              currency = m?.Unit ?? currency;
            }
            return `Billing ACTIVE — Cost Explorer reachable, month-to-date ${currency} ${Math.round(total * 100) / 100}. Cost flows into FinOps (data lags ~24h).`;
          } catch (err) {
            const msg = String((err as Error)?.message ?? err);
            if (/not enabled|opt.?in|no data|has not enabled/i.test(msg)) {
              throw new Error('Cost Explorer is NOT enabled on this account. Enable it once in the Billing console (Cost Explorer → Enable), then cost fills into FinOps within ~24h. Connectivity is fine — this only affects cost.');
            }
            if (/AccessDenied|not authorized|explicit deny/i.test(msg)) {
              throw new Error('Missing ce:GetCostAndUsage permission for this user. Re-run the AWS grant script from Help → Cloud Setup (it now includes Cost Explorer), then cost fills into FinOps. Connectivity is fine — this only affects cost.');
            }
            throw new Error(`Could not read billing/Cost Explorer state: ${msg}. Connectivity is fine — this only affects cost in FinOps.`);
          }
        },
      },
    ]);
  }

  async discover(_account: CloudAccountRef, credentials: ProviderCredentials): Promise<DiscoveredAsset[]> {
    this.creds = credentials;
    const regions = await this.listRegions();
    const perRegion = await Promise.all(
      regions.map(async (r) => {
        const [ec2, rds, vpcs] = await Promise.all([this.discoverEc2(r), this.discoverRds(r), this.discoverVpcs(r)]);
        return [...ec2, ...rds, ...vpcs];
      }),
    );
    const buckets = await this.discoverS3(); // S3 is global
    return [...perRegion.flat(), ...buckets];
  }

  /** Enumerate VPCs per region so MCMF-provisioned and pre-existing networks show in Inventory. */
  private async discoverVpcs(region: string): Promise<DiscoveredAsset[]> {
    const ec2 = new EC2Client(this.clientConfig(region));
    try {
      const res = await ec2.send(new DescribeVpcsCommand({}));
      return (res.Vpcs ?? [])
        .filter((v) => v.VpcId)
        .map((v) => {
          const nameTag = v.Tags?.find((t) => t.Key === 'Name')?.Value;
          return {
            resourceType: 'network:vpc',
            externalId: v.VpcId as string,
            name: nameTag ?? (v.VpcId as string),
            region,
            properties: {
              discoveredBy: 'aws-connector',
              cidr: v.CidrBlock,
              state: v.State,
              isDefault: v.IsDefault ?? false,
              tags: Object.fromEntries((v.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])),
            },
          };
        });
    } catch {
      return [];
    }
  }

  /** Authoritative Site-to-Site VPN tunnel status for the Replication/DR VPN monitor. */
  async vpnConnectionStatus(credentials: ProviderCredentials, vpnId: string): Promise<{ up: boolean; state: string; tunnels: { ip: string; status: string; msg: string }[] }> {
    this.creds = credentials;
    const ec2 = new EC2Client(this.clientConfig());
    const res = await ec2.send(new DescribeVpnConnectionsCommand({ VpnConnectionIds: [vpnId] }));
    const c = res.VpnConnections?.[0];
    const tels = c?.VgwTelemetry ?? [];
    const tunnels = tels.map((t) => ({ ip: t.OutsideIpAddress ?? '', status: String(t.Status ?? 'UNKNOWN'), msg: t.StatusMessage ?? '' }));
    return { up: tunnels.some((t) => t.status === 'UP'), state: String(c?.State ?? 'unknown'), tunnels };
  }

  /**
   * Cross-cloud fabric — create a Virtual Private Gateway and attach it to the VPC. NOTE: an AWS VGW has
   * no standalone public IP; its per-tunnel outside IPs are assigned only when a VPN connection is created
   * (fabricConnection), so publicIp is returned empty here and resolved after the connection exists.
   */
  async fabricGateway(credentials: ProviderCredentials, opts: { networkId: string; region?: string; name: string }): Promise<{ gatewayId: string; publicIp: string }> {
    this.creds = credentials;
    const ec2 = new EC2Client(this.clientConfig(opts.region));
    const vgw = await ec2.send(new CreateVpnGatewayCommand({ Type: 'ipsec.1', TagSpecifications: [{ ResourceType: 'vpn-gateway', Tags: [{ Key: 'Name', Value: opts.name }] }] }));
    const gatewayId = vgw.VpnGateway?.VpnGatewayId ?? '';
    if (!gatewayId) throw new Error('AWS did not return a VpnGatewayId');
    await ec2.send(new AttachVpnGatewayCommand({ VpnGatewayId: gatewayId, VpcId: opts.networkId }));
    return { gatewayId, publicIp: '' };
  }

  /** Create a Customer Gateway (peer IP), a static-route VPN connection with the shared key, and the route. */
  async fabricConnection(credentials: ProviderCredentials, opts: { gatewayId: string; region?: string; peerIp: string; peerCidr: string; localCidr: string; psk: string; name: string }): Promise<{ connId: string; outsideIps: string[] }> {
    this.creds = credentials;
    const ec2 = new EC2Client(this.clientConfig(opts.region));
    const cgw = await ec2.send(new CreateCustomerGatewayCommand({ Type: 'ipsec.1', PublicIp: opts.peerIp, BgpAsn: 65000, TagSpecifications: [{ ResourceType: 'customer-gateway', Tags: [{ Key: 'Name', Value: opts.name }] }] }));
    const cgwId = cgw.CustomerGateway?.CustomerGatewayId ?? '';
    const conn = await ec2.send(new CreateVpnConnectionCommand({
      Type: 'ipsec.1', CustomerGatewayId: cgwId, VpnGatewayId: opts.gatewayId,
      Options: { StaticRoutesOnly: true, TunnelOptions: [{ PreSharedKey: opts.psk }, { PreSharedKey: opts.psk }] },
    }));
    const connId = conn.VpnConnection?.VpnConnectionId ?? '';
    if (connId && opts.peerCidr) await ec2.send(new CreateVpnConnectionRouteCommand({ VpnConnectionId: connId, DestinationCidrBlock: opts.peerCidr })).catch(() => undefined);
    const outsideIps = (conn.VpnConnection?.VgwTelemetry ?? []).map((t) => t.OutsideIpAddress ?? '').filter(Boolean);
    return { connId, outsideIps };
  }

  /** Tear down a fabric's AWS VPN resources (connection, customer gateway, VGW). Best-effort per step. */
  async fabricTeardown(credentials: ProviderCredentials, opts: { connId: string; gatewayId: string; networkId: string; region?: string }): Promise<string[]> {
    this.creds = credentials;
    const ec2 = new EC2Client(this.clientConfig(opts.region));
    const done: string[] = [];
    let cgwId = '';
    if (opts.connId) {
      try { const d = await ec2.send(new DescribeVpnConnectionsCommand({ VpnConnectionIds: [opts.connId] })); cgwId = d.VpnConnections?.[0]?.CustomerGatewayId ?? ''; } catch { /* */ }
      try { await ec2.send(new DeleteVpnConnectionCommand({ VpnConnectionId: opts.connId })); done.push(`vpn-connection ${opts.connId}`); } catch (e) { done.push(`connection: ${(e as Error).message}`); }
    }
    if (cgwId) { try { await ec2.send(new DeleteCustomerGatewayCommand({ CustomerGatewayId: cgwId })); done.push(`customer-gateway ${cgwId}`); } catch (e) { done.push(`cgw: ${(e as Error).message}`); } }
    if (opts.gatewayId) {
      if (opts.networkId) { try { await ec2.send(new DetachVpnGatewayCommand({ VpnGatewayId: opts.gatewayId, VpcId: opts.networkId })); } catch { /* */ } }
      try { await ec2.send(new DeleteVpnGatewayCommand({ VpnGatewayId: opts.gatewayId })); done.push(`vpn-gateway ${opts.gatewayId}`); } catch (e) { done.push(`vgw: ${(e as Error).message}`); }
    }
    return done;
  }

  async getCost(credentials: ProviderCredentials): Promise<CostSummary | null> {
    this.creds = credentials;
    const cfg = this.clientConfig('us-east-1'); // Cost Explorer is a global (us-east-1) service
    const ce = new CostExplorerClient(cfg);
    const now = new Date();
    const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const end = new Date(now.getTime() + 86400_000).toISOString().slice(0, 10);
    try {
      const res = await ce.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: start, End: end },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        }),
      );
      const byService: { service: string; cost: number }[] = [];
      let total = 0;
      let currency = 'USD';
      for (const t of res.ResultsByTime ?? []) {
        for (const g of t.Groups ?? []) {
          const amt = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
          currency = g.Metrics?.UnblendedCost?.Unit ?? currency;
          if (amt <= 0) continue;
          total += amt;
          byService.push({ service: g.Keys?.[0] ?? 'Other', cost: Math.round(amt * 100) / 100 });
        }
      }
      byService.sort((a, b) => b.cost - a.cost);
      return { total: Math.round(total * 100) / 100, currency, byService };
    } catch (err) {
      console.warn(`[aws-connector] Cost Explorer skipped (enable CE + ce:GetCostAndUsage): ${String(err)}`);
      return null;
    }
  }

  async getFindings(credentials: ProviderCredentials): Promise<DiscoveredFinding[]> {
    this.creds = credentials;
    const sh = new SecurityHubClient(this.clientConfig());
    const out: DiscoveredFinding[] = [];
    try {
      const res = await sh.send(
        new GetFindingsCommand({
          Filters: { RecordState: [{ Value: 'ACTIVE', Comparison: 'EQUALS' }] },
          MaxResults: 100,
        }),
      );
      for (const f of res.Findings ?? []) {
        if (!f.Id) continue;
        const types = (f.Types ?? []).join(' ');
        const type = types.includes('Vulnerabilities')
          ? 'vulnerability'
          : types.includes('TTPs') || types.includes('Unusual Behaviors')
            ? 'threat'
            : 'misconfiguration';
        out.push({
          externalId: `aws:${f.Id}`,
          title: f.Title ?? 'Security Hub finding',
          type,
          severity: AWS_SEV[f.Severity?.Label ?? 'MEDIUM'] ?? 'medium',
          status: f.Workflow?.Status === 'RESOLVED' ? 'resolved' : 'open',
          source: 'securityhub',
          resourceName: f.Resources?.[0]?.Id?.split('/').pop() ?? f.Resources?.[0]?.Id,
          detectedAt: f.CreatedAt,
        });
      }
    } catch (err) {
      console.warn(`[aws-connector] Security Hub findings skipped (enable Security Hub): ${String(err)}`);
    }
    return out;
  }

  async getNetworkRules(credentials: ProviderCredentials): Promise<NetworkRule[]> {
    this.creds = credentials;
    const ec2 = new EC2Client(this.clientConfig());
    const out: NetworkRule[] = [];
    try {
      const res = await ec2.send(new DescribeSecurityGroupsCommand({ MaxResults: 200 }));
      for (const sg of res.SecurityGroups ?? []) {
        const name = sg.GroupName ?? sg.GroupId ?? 'sg';
        for (const perm of sg.IpPermissions ?? []) {
          const proto = perm.IpProtocol === '-1' ? 'all' : String(perm.IpProtocol);
          const ports = perm.IpProtocol === '-1' ? '*' : perm.FromPort === perm.ToPort ? String(perm.FromPort ?? '*') : `${perm.FromPort}-${perm.ToPort}`;
          for (const range of perm.IpRanges ?? []) {
            out.push({ resourceName: name, ruleName: range.Description ?? 'ingress', direction: 'inbound', access: 'allow', protocol: proto, source: range.CidrIp ?? '*', ports });
          }
          for (const range of perm.Ipv6Ranges ?? []) {
            out.push({ resourceName: name, ruleName: 'ingress', direction: 'inbound', access: 'allow', protocol: proto, source: range.CidrIpv6 ?? '*', ports });
          }
        }
      }
    } catch (err) {
      console.warn(`[aws-connector] DescribeSecurityGroups skipped: ${String(err)}`);
    }
    return out;
  }

  async remediateRule(credentials: ProviderCredentials, target: NetworkRuleTarget): Promise<{ ok: boolean; detail: string }> {
    this.creds = credentials;
    const ec2 = new EC2Client(this.clientConfig());
    const desc = await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [target.resourceName] }] }));
    const sg = desc.SecurityGroups?.[0];
    if (!sg?.GroupId) throw new Error(`security group "${target.resourceName}" not found`);
    const proto = target.protocol === 'all' ? '-1' : target.protocol;
    const perm: any = { IpProtocol: proto, IpRanges: [{ CidrIp: target.source }] };
    if (proto !== '-1' && target.ports !== '*') {
      if (target.ports.includes('-')) {
        const [a, b] = target.ports.split('-').map((n) => parseInt(n, 10));
        perm.FromPort = a;
        perm.ToPort = b;
      } else {
        const p = parseInt(target.ports, 10);
        perm.FromPort = p;
        perm.ToPort = p;
      }
    }
    await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: sg.GroupId, IpPermissions: [perm] }));
    return { ok: true, detail: `revoked ${target.ports}/${target.protocol} from ${target.source} on ${target.resourceName}` };
  }

  async control(action: PowerAction, ctx: ControlContext, credentials: ProviderCredentials): Promise<{ ok: boolean; detail: string }> {
    this.creds = credentials;
    const ec2 = new EC2Client(this.clientConfig(ctx.region));
    const ids = [cloudId(ctx.externalId)]; // strip MCMF's "provisioned:aws:vm:" prefix → real i-… id
    if (action === 'start') await ec2.send(new StartInstancesCommand({ InstanceIds: ids }));
    else if (action === 'stop') await ec2.send(new StopInstancesCommand({ InstanceIds: ids }));
    else await ec2.send(new RebootInstancesCommand({ InstanceIds: ids }));
    return { ok: true, detail: `${action} requested for ${ids[0]} in ${ctx.region}` };
  }

  /** Non-destructive readiness probe: ec2:CreateVpc with DryRun. */
  async testProvision(credentials: ProviderCredentials): Promise<{ ready: boolean; detail: string }> {
    this.creds = credentials;
    const ec2 = new EC2Client(this.clientConfig());
    try {
      await ec2.send(new CreateVpcCommand({ CidrBlock: '10.255.255.0/28', DryRun: true }));
      return { ready: true, detail: 'ec2:CreateVpc allowed.' };
    } catch (e: any) {
      if (e?.name === 'DryRunOperation') return { ready: true, detail: 'ec2:CreateVpc allowed (dry-run passed).' };
      if (e?.name === 'UnauthorizedOperation') return { ready: false, detail: 'Not authorized for ec2:CreateVpc — run the AWS grant script.' };
      return { ready: false, detail: `${e?.name ?? 'error'}: ${(e?.message ?? '').slice(0, 150)}` };
    }
  }

  /** Non-secret identity for the grant script: account id + IAM user name (from STS). */
  async identity(credentials: ProviderCredentials): Promise<ProvisionIdentity> {
    this.creds = credentials;
    const sts = new STSClient(this.clientConfig());
    const id = await sts.send(new GetCallerIdentityCommand({}));
    const arn = id.Arn ?? '';
    const principal = arn.includes(':user/') ? arn.split(':user/')[1] : arn.split('/').pop();
    return { account: id.Account, principal, region: this.region };
  }

  /** Live option pools for the provisioning form: regions + existing VPCs + subnets + latest AMIs (region-aware). */
  async listProvisionOptions(credentials: ProviderCredentials, region?: string): Promise<ProvisionOptions> {
    this.creds = credentials;
    const reg = (region || this.region).trim();
    const regions = (await this.listRegions()).map((r) => ({ value: r, label: r }));
    const ec2 = new EC2Client(this.clientConfig(reg));
    let networks: ProvisionOptions['networks'] = [];
    let subnets: ProvisionOptions['subnets'] = [];
    let images: ProvisionOptions['images'] = [];
    try {
      const res = await ec2.send(new DescribeVpcsCommand({}));
      networks = (res.Vpcs ?? []).map((v) => ({ value: v.VpcId ?? '', label: `${v.Tags?.find((t) => t.Key === 'Name')?.Value ?? v.VpcId} (${v.CidrBlock})`, region: reg }));
    } catch { /* best-effort */ }
    try {
      const res = await ec2.send(new DescribeSubnetsCommand({}));
      subnets = (res.Subnets ?? []).map((s) => ({ value: s.SubnetId ?? '', label: `${s.SubnetId} · ${s.CidrBlock} · ${s.AvailabilityZone}${s.Tags?.find((t) => t.Key === 'Name')?.Value ? ` (${s.Tags.find((t) => t.Key === 'Name')!.Value})` : ''}` }));
    } catch { /* best-effort */ }
    try {
      images = await this.latestAmis(ec2);
    } catch { /* best-effort */ }
    return { regions, networks, subnets, images };
  }

  /** Newest Amazon Linux 2023 + Ubuntu 22.04 AMIs for the client's region. */
  private async latestAmis(ec2: EC2Client): Promise<{ value: string; label: string }[]> {
    const newest = async (owners: string[], name: string) => {
      const r = await ec2.send(new DescribeImagesCommand({ Owners: owners, Filters: [{ Name: 'name', Values: [name] }, { Name: 'architecture', Values: ['x86_64'] }, { Name: 'state', Values: ['available'] }] }));
      const img = (r.Images ?? []).sort((a, b) => String(b.CreationDate).localeCompare(String(a.CreationDate)))[0];
      return img?.ImageId ? { id: img.ImageId, name: img.Name ?? '' } : null;
    };
    const out: { value: string; label: string }[] = [];
    const al = await newest(['amazon'], 'al2023-ami-2023.*-x86_64').catch(() => null);
    if (al) out.push({ value: al.id, label: `Amazon Linux 2023 (${al.id})` });
    const ub = await newest(['099720109477'], 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*').catch(() => null);
    if (ub) out.push({ value: ub.id, label: `Ubuntu 22.04 LTS (${ub.id})` });
    return out;
  }

  /** Live resource creation. Today: Network (VPC + default subnet). */
  async provision(credentials: ProviderCredentials, spec: ProvisionSpec): Promise<ProvisionResult> {
    this.creds = credentials;
    if (spec.kind === 'network') {
      const region = (spec.region || this.region).trim();
      const cidr = (spec.cidr || '10.30.0.0/16').trim();
      const ec2 = new EC2Client(this.clientConfig(region));

      let vpcId: string | undefined;
      try {
        const vpc = await ec2.send(new CreateVpcCommand({
          CidrBlock: cidr,
          TagSpecifications: [{ ResourceType: 'vpc', Tags: [{ Key: 'Name', Value: spec.name }, { Key: 'createdBy', Value: 'MCMF' }] }],
        }));
        vpcId = vpc.Vpc?.VpcId;
      } catch (e) {
        throw awsProvisionError('VPC create', e);
      }

      const subnetCidr = (spec.subnetCidr || '').trim() || awsDefaultSubnet(cidr);
      try {
        await ec2.send(new CreateSubnetCommand({
          VpcId: vpcId,
          CidrBlock: subnetCidr,
          TagSpecifications: [{ ResourceType: 'subnet', Tags: [{ Key: 'Name', Value: `${spec.name}-subnet` }, { Key: 'createdBy', Value: 'MCMF' }] }],
        }));
      } catch (e) {
        throw awsProvisionError('Subnet create', e);
      }
      return { ok: true, detail: `Created VPC "${spec.name}" (${cidr}, subnet ${subnetCidr}) ${vpcId} in ${region}.`, externalId: vpcId };
    }

    if (spec.kind === 'vm') {
      const region = (spec.region || this.region).trim();
      const ec2 = new EC2Client(this.clientConfig(region));
      const ami = (spec.ami ?? '').trim();
      if (!ami) throw new ProvisionError('AMI required', 'Validate input', 'Enter a region-specific AMI id (e.g. ami-0abcd1234) for the chosen region.');
      const instanceType = (spec.instanceType || 't3.micro').trim();
      const adminUsername = String(spec.adminUsername || '').trim();
      const adminPassword = String(spec.adminPassword || '');
      if (!adminUsername || !adminPassword) throw new ProvisionError('admin username + password required', 'Validate input', 'Enter an admin username and password for the VM (used for SSH login).');
      // cloud-init: create the admin user with the password + enable SSH password auth.
      const keyLine = spec.sshPublicKey ? `\n    ssh_authorized_keys:\n      - ${String(spec.sshPublicKey).trim()}` : '';
      const cloudInit = `#cloud-config\nusers:\n  - name: ${adminUsername}\n    groups: [sudo, wheel]\n    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n    shell: /bin/bash\n    lock_passwd: false${keyLine}\nssh_pwauth: true\nchpasswd:\n  expire: false\n  list:\n    - ${adminUsername}:${adminPassword}\n`;
      const userData = Buffer.from(cloudInit).toString('base64');
      // Console firewall: a security group opening the chosen ports from the chosen sources, attached
      // to the instance via a public-IP network interface — so SSH/RDP + the browser console reach it.
      const ports = (Array.isArray(spec.consolePorts) ? spec.consolePorts : String(spec.consolePorts ?? '').split(','))
        .map((s) => String(s).trim()).filter((s) => /^\d{1,5}$/.test(s));
      const sources = String(spec.sourceCidrs ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      let sgId: string | undefined;
      let consoleHint: string | undefined;
      try {
        if (ports.length) {
          // Resolve the VPC (from the chosen subnet, else the region's default VPC).
          let vpcId: string | undefined;
          if (spec.subnetId) { const sn = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [String(spec.subnetId)] })); vpcId = sn.Subnets?.[0]?.VpcId; }
          if (!vpcId) { const v = await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] })); vpcId = v.Vpcs?.[0]?.VpcId; }
          const sg = await ec2.send(new CreateSecurityGroupCommand({ GroupName: `mcmf-${spec.name}-console-${Date.now().toString().slice(-5)}`, Description: 'MCMF console access', VpcId: vpcId }));
          sgId = sg.GroupId;
          await ec2.send(new AuthorizeSecurityGroupIngressCommand({
            GroupId: sgId,
            IpPermissions: ports.map((p) => ({ IpProtocol: 'tcp', FromPort: Number(p), ToPort: Number(p), IpRanges: (sources.length ? sources : ['0.0.0.0/0']).map((c) => ({ CidrIp: c, Description: 'MCMF console' })) })),
          }));
          consoleHint = `opened TCP ${ports.join(', ')} from ${sources.length ? sources.join(', ') : 'any'}`;
        }
        const r = await ec2.send(new RunInstancesCommand({
          ImageId: ami,
          InstanceType: instanceType as any,
          MinCount: 1,
          MaxCount: 1,
          UserData: userData,
          ...(spec.keyPair ? { KeyName: String(spec.keyPair) } : {}),
          // With an SG, use a public-IP network interface (carries the SG + subnet); else top-level subnet.
          ...(sgId
            ? { NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: true, Groups: [sgId], DeleteOnTermination: true, ...(spec.subnetId ? { SubnetId: String(spec.subnetId) } : {}) }] }
            : (spec.subnetId ? { SubnetId: String(spec.subnetId) } : {})),
          ...(spec.volumeSizeGb ? { BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: Number(spec.volumeSizeGb) } }] } : {}),
          TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: spec.name }, { Key: 'createdBy', Value: 'MCMF' }] }],
        }));
        const id = r.Instances?.[0]?.InstanceId;
        return { ok: true, detail: `Launching EC2 "${spec.name}" (${instanceType}, user ${adminUsername})${consoleHint ? ` — ${consoleHint}` : ''} ${id} in ${region}.`, externalId: id, consoleHint };
      } catch (e) {
        throw awsProvisionError('Instance launch', e);
      }
    }

    if (spec.kind === 'disk') {
      const region = (spec.region || this.region).trim();
      const az = (spec.availabilityZone ?? '').trim() || `${region}a`;
      const ec2 = new EC2Client(this.clientConfig(region));
      try {
        const r = await ec2.send(new CreateVolumeCommand({
          AvailabilityZone: az,
          Size: Number(spec.sizeGb || 100),
          VolumeType: (spec.volumeType || 'gp3') as any,
          TagSpecifications: [{ ResourceType: 'volume', Tags: [{ Key: 'Name', Value: spec.name }, { Key: 'createdBy', Value: 'MCMF' }] }],
        }));
        return { ok: true, detail: `Created EBS volume "${spec.name}" (${spec.sizeGb} GB, ${spec.volumeType || 'gp3'}) ${r.VolumeId} in ${az}.`, externalId: r.VolumeId };
      } catch (e) {
        throw awsProvisionError('Volume create', e);
      }
    }

    throw new ProvisionError(`aws live provisioning for "${spec.kind}" is not enabled yet`, 'Capability', 'AWS network, VM and disk creation are implemented.');
  }

  /** Terminate a provisioned EC2 instance (its public-IP ENI + MCMF SG auto-clean on termination). */
  async deprovision(credentials: ProviderCredentials, spec: ProvisionSpec): Promise<ProvisionResult> {
    if (spec.kind !== 'vm') throw new ProvisionError('only VM delete is supported', 'Validate input', 'Delete is implemented for VMs.');
    this.creds = credentials;
    const region = (spec.region || this.region).trim();
    const id = String((spec as any).externalId || (spec as any).instanceId || '').trim();
    if (!/^i-[0-9a-f]+$/i.test(id)) throw new ProvisionError('instance id required', 'Validate input', 'Need the EC2 instance id (i-…) to terminate.');
    const ec2 = new EC2Client(this.clientConfig(region));
    try {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }));
      return { ok: true, detail: `Terminating EC2 instance ${id} in ${region}.` };
    } catch (e) {
      throw awsProvisionError('Instance terminate', e);
    }
  }

  private async discoverEc2(region: string): Promise<DiscoveredAsset[]> {
    const ec2 = new EC2Client(this.clientConfig(region));
    const assets: DiscoveredAsset[] = [];
    let token: string | undefined;
    try {
      do {
        const res = await ec2.send(new DescribeInstancesCommand({ NextToken: token, MaxResults: 100 }));
        for (const reservation of res.Reservations ?? []) {
          for (const inst of reservation.Instances ?? []) {
            if (!inst.InstanceId) continue;
            const nameTag = inst.Tags?.find((t) => t.Key === 'Name')?.Value;
            assets.push({
              resourceType: 'compute:instance',
              externalId: inst.InstanceId,
              name: nameTag ?? inst.InstanceId,
              region: inst.Placement?.AvailabilityZone?.replace(/.$/, '') ?? region,
              properties: {
                discoveredBy: 'aws-connector',
                instanceType: inst.InstanceType,
                size: inst.InstanceType,
                state: inst.State?.Name,
                os: String(inst.Platform ?? '').toLowerCase() === 'windows' || (inst.PlatformDetails ?? '').toLowerCase().includes('windows') ? 'windows' : 'linux',
                imageId: inst.ImageId,
                platformDetails: inst.PlatformDetails,
                az: inst.Placement?.AvailabilityZone,
                privateIp: inst.PrivateIpAddress,
                publicIp: inst.PublicIpAddress,
                launchTime: inst.LaunchTime?.toISOString(),
                tags: Object.fromEntries((inst.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])),
              },
            });
          }
        }
        token = res.NextToken;
      } while (token);

      // Enrich each instance with its exact OS version, parsed from the AMI name (batched lookup).
      const amiIds = [...new Set(assets.map((a) => a.properties.imageId).filter(Boolean) as string[])];
      if (amiIds.length) {
        const nameById = new Map<string, string>();
        for (let i = 0; i < amiIds.length; i += 100) {
          try {
            const imgs = await ec2.send(new DescribeImagesCommand({ ImageIds: amiIds.slice(i, i + 100) }));
            for (const img of imgs.Images ?? []) if (img.ImageId) nameById.set(img.ImageId, `${img.Name ?? ''} ${img.Description ?? ''}`);
          } catch (e) { console.warn(`[aws-connector] DescribeImages ${region}: ${String(e)}`); }
        }
        for (const a of assets) {
          const ov = awsOsVersion(nameById.get(a.properties.imageId as string), a.properties.platformDetails as string);
          if (ov) a.properties.osVersion = ov;
        }
      }
    } catch (err) {
      console.warn(`[aws-connector] EC2 ${region} skipped: ${String(err)}`);
    }
    return assets;
  }

  private async discoverRds(region: string): Promise<DiscoveredAsset[]> {
    const rds = new RDSClient(this.clientConfig(region));
    const assets: DiscoveredAsset[] = [];
    try {
      let marker: string | undefined;
      do {
        const res = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }));
        for (const db of res.DBInstances ?? []) {
          if (!db.DBInstanceIdentifier) continue;
          assets.push({
            resourceType: 'database:instance',
            externalId: db.DbiResourceId ?? db.DBInstanceIdentifier,
            name: db.DBInstanceIdentifier,
            region: db.AvailabilityZone?.replace(/.$/, '') ?? region,
            properties: {
              discoveredBy: 'aws-connector',
              engine: db.Engine,
              engineVersion: db.EngineVersion,
              instanceClass: db.DBInstanceClass,
              status: db.DBInstanceStatus,
              storageGb: db.AllocatedStorage,
            },
          });
        }
        marker = res.Marker;
      } while (marker);
    } catch (err) {
      console.warn(`[aws-connector] RDS ${region} skipped: ${String(err)}`);
    }
    return assets;
  }

  private async discoverS3(): Promise<DiscoveredAsset[]> {
    const s3 = new S3Client(this.clientConfig());
    const assets: DiscoveredAsset[] = [];
    try {
      const res = await s3.send(new ListBucketsCommand({}));
      for (const b of res.Buckets ?? []) {
        if (!b.Name) continue;
        assets.push({
          resourceType: 'storage:bucket',
          externalId: `s3:${b.Name}`,
          name: b.Name,
          region: this.region,
          properties: {
            discoveredBy: 'aws-connector',
            createdAt: b.CreationDate?.toISOString(),
          },
        });
      }
    } catch (err) {
      console.warn(`[aws-connector] S3 list skipped: ${String(err)}`);
    }
    return assets;
  }
}
