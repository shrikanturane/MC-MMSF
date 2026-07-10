/**
 * Estimated / summary-level FinOps + Carbon (GreenOps) engine.
 *
 * No real billing line-items or power meters are available for every asset, so this
 * derives an *estimated* energy + emissions figure using the widely-used Cloud Carbon
 * Footprint methodology: energy (kWh) = avg-watts x hours x PUE; emissions = energy x
 * grid carbon intensity (gCO2e/kWh). Cost re-uses the per-resource monthlyCost the
 * connectors already populate. Everything here is deterministic and clearly "estimated".
 */

export const HOURS_PER_MONTH = 730;

export interface CostCarbonResource {
  name: string;
  provider: string;
  type: string; // ResourceType
  region: string;
  status: string; // running | stopped | ...
  cpuPct: number;
  memoryPct: number;
  monthlyCost: number;
  diskPct?: number | null;
  properties?: any;
}

// ── Grid carbon intensity (gCO2e/kWh) ──────────────────────────────────────
// Representative location-based averages. Matched by keyword so it works across
// AWS/Azure/GCP region naming and free-text on-prem regions.
const INTENSITY_RULES: { test: RegExp; gco2: number; label: string }[] = [
  { test: /(eu-?north|stockholm|sweden|finland|norway)/i, gco2: 18, label: 'Nordics' },
  { test: /(montreal|canada|ca-?central|quebec)/i, gco2: 120, label: 'Canada' },
  { test: /(oregon|us-?west-?2|washington)/i, gco2: 120, label: 'US West (Oregon)' },
  { test: /(us-?west-?1|california|sf|san-?jose)/i, gco2: 210, label: 'US West (California)' },
  { test: /(sa-?east|brazil|s.o-?paulo|saopaulo)/i, gco2: 80, label: 'Brazil' },
  { test: /(france|paris|eu-?west-?3)/i, gco2: 56, label: 'France' },
  { test: /(switzerland|zurich)/i, gco2: 45, label: 'Switzerland' },
  { test: /(ireland|eu-?west-?1|dublin)/i, gco2: 290, label: 'Ireland' },
  { test: /(london|uk-?south|eu-?west-?2|britain)/i, gco2: 230, label: 'UK' },
  { test: /(frankfurt|germany|eu-?central-?1)/i, gco2: 350, label: 'Germany' },
  { test: /(netherlands|amsterdam|west-?europe)/i, gco2: 330, label: 'Netherlands' },
  { test: /(virginia|us-?east-?1|n-?virginia|ashburn)/i, gco2: 370, label: 'US East (Virginia)' },
  { test: /(ohio|us-?east-?2)/i, gco2: 430, label: 'US East (Ohio)' },
  { test: /(mumbai|pune|hyderabad|chennai|india|ap-?south-?1|central-?india|south-?india)/i, gco2: 708, label: 'India' },
  { test: /(singapore|ap-?southeast-?1)/i, gco2: 408, label: 'Singapore' },
  { test: /(tokyo|japan|ap-?northeast-?1|osaka)/i, gco2: 470, label: 'Japan' },
  { test: /(seoul|korea|ap-?northeast-?2)/i, gco2: 415, label: 'South Korea' },
  { test: /(sydney|australia|ap-?southeast-?2|melbourne)/i, gco2: 560, label: 'Australia' },
  { test: /(hong-?kong|ap-?east)/i, gco2: 600, label: 'Hong Kong' },
  { test: /(beijing|shanghai|china|cn-?north)/i, gco2: 580, label: 'China' },
  { test: /(jakarta|indonesia)/i, gco2: 650, label: 'Indonesia' },
  { test: /(south-?africa|johannesburg|af-?south)/i, gco2: 870, label: 'South Africa' },
  { test: /(uae|dubai|bahrain|me-?south|me-?central|saudi)/i, gco2: 520, label: 'Middle East' },
];
// Global grid average fallback (IEA ~2023).
const DEFAULT_INTENSITY = { gco2: 475, label: 'Global average' };

export function gridIntensity(region: string, _provider: string): { gco2: number; label: string } {
  const r = region || '';
  for (const rule of INTENSITY_RULES) if (rule.test.test(r)) return { gco2: rule.gco2, label: rule.label };
  return DEFAULT_INTENSITY;
}

// ── Power Usage Effectiveness (datacentre overhead) ────────────────────────
export function providerPUE(provider: string): number {
  switch (provider) {
    case 'gcp': return 1.10;
    case 'azure': return 1.125;
    case 'aws': return 1.135;
    case 'docker': return 1.4; // typically co-located on-prem
    default: return 1.58; // industry-average on-prem / private cloud (Uptime Institute)
  }
}

// Annual renewable / carbon-free energy matching by provider (informational, market-based).
export function renewablePct(provider: string): number {
  switch (provider) {
    case 'gcp': return 64; // 24/7 CFE average
    case 'aws': return 90; // annual renewable matched
    case 'azure': return 60;
    default: return 0;
  }
}

const COMPUTE_LIKE = new Set(['compute', 'container', 'database', 'analytics']);

/** Estimate effective vCPU count for an asset (specs if present, else cost-derived). */
function estimateVcpu(r: CostCarbonResource): number {
  const p = r.properties ?? {};
  const spec = Number(p.cpuCores ?? p.vcpus ?? p.vCPUs ?? p.numberOfCores ?? 0);
  if (spec > 0) return Math.min(spec, 128);
  // Cost proxy: VM pricing is roughly linear in size (~$25–35 per vCPU/mo on-demand).
  return Math.min(Math.max(Math.round(r.monthlyCost / 32), 1), 64);
}

/** Average power draw (watts) for a single resource, utilisation-aware. */
export function estimateWatts(r: CostCarbonResource): number {
  const running = r.status === 'running';
  const util = Math.max(0, Math.min(100, r.cpuPct || 0)) / 100;
  if (COMPUTE_LIKE.has(r.type)) {
    const vcpu = estimateVcpu(r);
    const idleW = 7; // per vCPU at idle
    const maxW = 21; // per vCPU at full load
    const active = vcpu * (idleW + (maxW - idleW) * util);
    return running ? active : active * 0.06; // deallocated compute ≈ negligible draw
  }
  if (r.type === 'storage') {
    // Storage keeps drawing whether or not "running"; scale modestly with cost (capacity proxy).
    return Math.min(Math.max(r.monthlyCost * 0.18, 1), 60);
  }
  if (r.type === 'serverless') {
    return running ? Math.min(Math.max(r.monthlyCost * 0.08, 0.3), 12) * (0.4 + util) : 0.3;
  }
  // network / security / other — light, lightly utilisation-scaled.
  const base = Math.min(Math.max(r.monthlyCost * 0.1, 0.5), 30);
  return running ? base * (0.6 + 0.4 * util) : base * 0.2;
}

/** Estimated electricity (kWh) for the month, including datacentre PUE overhead. */
export function estimateEnergyKWh(r: CostCarbonResource): number {
  const watts = estimateWatts(r);
  const pue = providerPUE(r.provider);
  return (watts * HOURS_PER_MONTH * pue) / 1000;
}

/** Estimated operational emissions (kg CO2e) for the month. */
export function estimateEmissionsKg(r: CostCarbonResource): number {
  const kwh = estimateEnergyKWh(r);
  const { gco2 } = gridIntensity(r.region, r.provider);
  return (kwh * gco2) / 1000;
}

// Real-world equivalents for an annual tonnage (EPA greenhouse-gas equivalencies).
export function carbonEquivalents(tonnesPerYear: number) {
  return {
    treeSeedlings: Math.round(tonnesPerYear * 1000 / 21), // ~21 kg CO2 sequestered/tree/yr
    passengerCars: Math.round((tonnesPerYear / 4.6) * 10) / 10, // ~4.6 t/car/yr
    homesPowered: Math.round((tonnesPerYear / 5.5) * 10) / 10, // ~5.5 t/home/yr (electricity)
    flightsLondonNY: Math.round(tonnesPerYear / 0.986), // ~0.986 t per one-way economy seat
  };
}

export const PROVIDER_LABELS: Record<string, string> = {
  aws: 'AWS', azure: 'Azure', gcp: 'GCP', docker: 'Docker', private: 'Private Cloud',
  linux: 'Linux Host', windows: 'Windows Host', vmware: 'VMware', esxi: 'ESXi',
  nutanix: 'Nutanix', proxmox: 'Proxmox', kvm: 'KVM',
};
