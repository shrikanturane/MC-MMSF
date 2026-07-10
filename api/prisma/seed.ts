import { PrismaClient, Provider, ResourceType, ResourceStatus, CloudAccount } from '@prisma/client';

const prisma = new PrismaClient();

// Deterministic pseudo-random so seeds are reproducible.
let _s = 1337;
function rand() {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff;
  return _s / 0x7fffffff;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}
function between(min: number, max: number, dp = 0) {
  const v = min + rand() * (max - min);
  return Number(v.toFixed(dp));
}

const REGIONS: Record<Provider, string[]> = {
  aws: ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1'],
  azure: ['eastus', 'westeurope', 'southeastasia', 'centralus'],
  gcp: ['us-central1', 'europe-west1', 'asia-east1'],
  private: ['dc-nyc-01', 'dc-fra-02', 'dc-sin-03'],
};

const SERVICES: Record<Provider, Partial<Record<ResourceType, string>>> = {
  aws: { compute: 'EC2', storage: 'S3', network: 'VPC', database: 'RDS', container: 'EKS', serverless: 'Lambda', security: 'GuardDuty', analytics: 'Athena' },
  azure: { compute: 'Virtual Machines', storage: 'Blob Storage', network: 'VNet', database: 'Azure SQL', container: 'AKS', serverless: 'Functions', security: 'Defender', analytics: 'Synapse' },
  gcp: { compute: 'Compute Engine', storage: 'Cloud Storage', network: 'VPC', database: 'Cloud SQL', container: 'GKE', serverless: 'Cloud Functions', security: 'SCC', analytics: 'BigQuery' },
  private: { compute: 'vSphere VM', storage: 'Ceph', network: 'NSX', database: 'PostgreSQL', container: 'OpenShift', serverless: 'Knative', security: 'Falco', analytics: 'Spark' },
};

async function main() {
  // Demo data is OPT-IN. A fresh install starts clean — NO pre-populated cloud accounts,
  // resources, findings or integrations. Set DEMO_SEED=1 to load the sample "Acme" dataset
  // for a quick showcase. The app still bootstraps its own structural data (default admin,
  // roles, approval policies) via each module's onModuleInit — independent of this seed.
  if (process.env.DEMO_SEED !== '1') {
    console.log('Clean install — skipping sample data. Set DEMO_SEED=1 to load the "Acme" demo dataset.');
    return;
  }

  const existing = await prisma.cloudAccount.count();
  if (existing > 0 && process.env.SEED_FORCE !== '1') {
    console.log(`Already seeded (${existing} accounts). Skipping. Set SEED_FORCE=1 to reseed.`);
    return;
  }

  console.log('Resetting tables…');
  await prisma.securityFinding.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.cloudAccount.deleteMany();
  await prisma.metricPoint.deleteMany();
  await prisma.complianceFramework.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.automationWorkflow.deleteMany();
  await prisma.integration.deleteMany();

  // ── Cloud accounts ──────────────────────────────────────────────
  console.log('Seeding cloud accounts…');
  const accountSpecs: { name: string; provider: Provider; ref: string; status: any }[] = [
    { name: 'Acme Production', provider: 'aws', ref: '4471-2093-8841', status: 'connected' },
    { name: 'Acme Staging', provider: 'aws', ref: '9921-4410-2284', status: 'connected' },
    { name: 'Acme Analytics', provider: 'aws', ref: '1182-7740-9930', status: 'warning' },
    { name: 'Acme Corp Azure', provider: 'azure', ref: 'sub-7a31-prod', status: 'connected' },
    { name: 'Acme EU Azure', provider: 'azure', ref: 'sub-2b88-eu', status: 'connected' },
    { name: 'Acme Data Platform', provider: 'gcp', ref: 'acme-data-prod', status: 'connected' },
    { name: 'Acme ML Platform', provider: 'gcp', ref: 'acme-ml-880', status: 'error' },
    { name: 'On-Prem DC East', provider: 'private', ref: 'dc-nyc-cluster', status: 'connected' },
  ];
  const accounts: CloudAccount[] = [];
  for (const a of accountSpecs) {
    accounts.push(
      await prisma.cloudAccount.create({
        data: {
          name: a.name,
          provider: a.provider,
          accountRef: a.ref,
          region: REGIONS[a.provider][0],
          status: a.status,
        },
      }),
    );
  }

  // ── Resources ───────────────────────────────────────────────────
  console.log('Seeding resources…');
  const types: ResourceType[] = ['compute', 'storage', 'network', 'database', 'container', 'serverless', 'security', 'analytics'];
  const statuses: ResourceStatus[] = ['running', 'running', 'running', 'running', 'degraded', 'stopped'];
  const namePrefixes = ['prod', 'staging', 'web', 'api', 'worker', 'db', 'cache', 'queue', 'batch', 'edge'];
  const RESOURCE_COUNT = 220;

  for (let i = 0; i < RESOURCE_COUNT; i++) {
    const account = pick(accounts);
    const provider = account.provider as Provider;
    const type = pick(types);
    const status = pick(statuses);
    const isComputeHeavy = type === 'compute' || type === 'container' || type === 'database';
    await prisma.resource.create({
      data: {
        name: `${pick(namePrefixes)}-${type}-node-${String(i).padStart(2, '0')}`,
        externalId: `${provider}-${type}-${i}-${Math.floor(rand() * 1e6)}`,
        provider,
        type,
        region: pick(REGIONS[provider]),
        status,
        cpuPct: status === 'stopped' ? 0 : between(8, 96, 1),
        memoryPct: status === 'stopped' ? 0 : between(15, 94, 1),
        monthlyCost: between(40, isComputeHeavy ? 2400 : 600, 2),
        service: SERVICES[provider][type] ?? type,
        cloudAccountId: account.id,
      },
    });
  }

  // Roll account aggregates up from resources.
  for (const account of accounts) {
    const agg = await prisma.resource.aggregate({
      where: { cloudAccountId: account.id },
      _count: true,
      _sum: { monthlyCost: true },
    });
    await prisma.cloudAccount.update({
      where: { id: account.id },
      data: { resourceCount: agg._count, monthlyCost: agg._sum.monthlyCost ?? 0 },
    });
  }

  // ── Metric points (last 24h hourly) ─────────────────────────────
  console.log('Seeding metric points…');
  const now = Date.now();
  for (let h = 23; h >= 0; h--) {
    const ts = new Date(now - h * 3600_000);
    const wave = Math.sin((h / 24) * Math.PI * 2);
    await prisma.metricPoint.create({
      data: {
        ts,
        avgCpu: Number((62 + wave * 9 + between(-3, 3, 1)).toFixed(1)),
        avgMemory: Number((70 + wave * 6 + between(-2, 2, 1)).toFixed(1)),
        networkGbps: Number((3.1 + wave * 0.8 + between(-0.3, 0.3, 2)).toFixed(2)),
      },
    });
  }

  // ── Security findings ───────────────────────────────────────────
  console.log('Seeding security findings…');
  const resources = await prisma.resource.findMany({ select: { id: true, provider: true, name: true } });
  const vulnTitles = ['Outdated OpenSSL (CVE-2024-3094)', 'Unpatched kernel vulnerability', 'Log4j RCE exposure', 'Privilege escalation risk', 'Exposed admin endpoint'];
  const misconfigTitles = ['Public S3 bucket', 'Security group allows 0.0.0.0/0:22', 'Unencrypted EBS volume', 'IAM user without MFA', 'Storage account public access'];
  const threatTitles = ['Brute force attack detected', 'Anomalous data egress', 'Crypto-mining activity', 'Suspicious API calls', 'Impossible travel login'];

  const findingPlan: { type: any; titles: string[]; sev: any[] }[] = [
    { type: 'vulnerability', titles: vulnTitles, sev: ['critical', 'high', 'high', 'medium', 'low'] },
    { type: 'misconfiguration', titles: misconfigTitles, sev: ['high', 'medium', 'medium', 'low'] },
    { type: 'threat', titles: threatTitles, sev: ['critical', 'high', 'medium'] },
  ];
  // 156 open vulns + 44 misconfigs + 26 threats spread across resources.
  const counts = { vulnerability: 156, misconfiguration: 44, threat: 26 };
  for (const plan of findingPlan) {
    const n = (counts as any)[plan.type];
    for (let i = 0; i < n; i++) {
      const r = pick(resources);
      await prisma.securityFinding.create({
        data: {
          title: pick(plan.titles),
          type: plan.type,
          severity: pick(plan.sev),
          status: rand() > 0.85 ? 'resolved' : rand() > 0.6 ? 'investigating' : 'open',
          provider: r.provider,
          resourceId: r.id,
          detectedAt: new Date(now - between(0, 1000, 0) * 3600_000),
        },
      });
    }
  }

  // ── Compliance frameworks ───────────────────────────────────────
  console.log('Seeding compliance frameworks…');
  const frameworks = [
    { name: 'CIS Benchmark', score: 87, passed: 174, total: 200 },
    { name: 'SOC 2 Type II', score: 92, passed: 138, total: 150 },
    { name: 'ISO 27001', score: 79, passed: 95, total: 120 },
    { name: 'HIPAA', score: 84, passed: 67, total: 80 },
    { name: 'PCI DSS', score: 73, passed: 80, total: 110 },
    { name: 'NIST CSF', score: 88, passed: 97, total: 110 },
  ];
  for (const f of frameworks) await prisma.complianceFramework.create({ data: f });

  // ── Incidents ───────────────────────────────────────────────────
  console.log('Seeding incidents…');
  const incidentSpecs = [
    { title: 'EC2 cluster unreachable', severity: 'critical', provider: 'aws', resourceName: 'prod-compute-node-04', status: 'open' },
    { title: 'RDS high replica lag', severity: 'high', provider: 'aws', resourceName: 'db-database-node-11', status: 'acknowledged' },
    { title: 'AKS pod crash loop', severity: 'high', provider: 'azure', resourceName: 'api-container-node-07', status: 'open' },
    { title: 'GCS bucket latency spike', severity: 'medium', provider: 'gcp', resourceName: 'web-storage-node-19', status: 'open' },
    { title: 'On-prem node disk pressure', severity: 'medium', provider: 'private', resourceName: 'batch-compute-node-22', status: 'acknowledged' },
    { title: 'Lambda throttling', severity: 'low', provider: 'aws', resourceName: 'queue-serverless-node-31', status: 'resolved' },
  ];
  for (const s of incidentSpecs) {
    await prisma.incident.create({
      data: {
        title: s.title,
        severity: s.severity as any,
        provider: s.provider as any,
        resourceName: s.resourceName,
        status: s.status as any,
        openedAt: new Date(now - between(1, 72, 0) * 3600_000),
        resolvedAt: s.status === 'resolved' ? new Date(now - 1800_000) : null,
      },
    });
  }

  // ── Alerts ──────────────────────────────────────────────────────
  console.log('Seeding alerts…');
  const alertSpecs = [
    { title: 'RDS Cluster Unreachable', severity: 'critical', source: 'CloudWatch' },
    { title: 'Brute Force Attack Detected', severity: 'critical', source: 'GuardDuty' },
    { title: 'High Disk Latency', severity: 'high', source: 'Azure Monitor' },
    { title: 'Docker Registry High Disk Usage', severity: 'high', source: 'Prometheus' },
    { title: 'Azure SQL DB Degraded', severity: 'high', source: 'Azure Monitor' },
    { title: 'Node Force Admin Restart', severity: 'medium', source: 'PagerDuty' },
    { title: 'Kafka Service Lag', severity: 'medium', source: 'Prometheus' },
    { title: 'SSL Certificate Expiring', severity: 'low', source: 'Cert Monitor' },
  ];
  for (const s of alertSpecs) {
    await prisma.alert.create({
      data: {
        title: s.title,
        severity: s.severity as any,
        source: s.source,
        status: rand() > 0.8 ? 'acknowledged' : 'active',
        raisedAt: new Date(now - between(0, 240, 0) * 60_000),
      },
    });
  }

  // ── Automation workflows ────────────────────────────────────────
  console.log('Seeding automation workflows…');
  const workflows = [
    { name: 'Auto-scale on high CPU', trigger: 'cpu > 85%', runs: 142 },
    { name: 'Quarantine on threat', trigger: 'GuardDuty critical', runs: 18 },
    { name: 'Nightly snapshot backup', trigger: 'schedule: 02:00', runs: 365 },
    { name: 'Restart on crash loop', trigger: 'pod restart > 5', runs: 27 },
    { name: 'Cost anomaly notify', trigger: 'spend +20%', runs: 9 },
    { name: 'Rotate IAM keys', trigger: 'schedule: weekly', runs: 52 },
  ];
  for (const w of workflows) {
    await prisma.automationWorkflow.create({
      data: { name: w.name, trigger: w.trigger, runs: w.runs, status: 'enabled', lastRun: new Date(now - between(1, 48, 0) * 3600_000) },
    });
  }

  // ── Integrations + settings ─────────────────────────────────────
  console.log('Seeding integrations + settings…');
  await prisma.integration.createMany({
    data: [
      { name: 'Slack', kind: 'slack', target: '#cloud-ops', status: 'connected' },
      { name: 'PagerDuty', kind: 'pagerduty', target: 'ops-escalation', status: 'connected' },
      { name: 'Generic Webhook', kind: 'webhook', target: 'https://hooks.acme.com/mcmf', status: 'disconnected' },
    ],
  });

  await prisma.orgSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      modules: {
        management: true,
        monitoring: true,
        security: true,
        inventory: true,
        commandCenter: true,
        costAnalytics: true,
        reports: true,
        privateCloud: true,
      },
    },
  });

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
