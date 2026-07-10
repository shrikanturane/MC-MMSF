import {
  gridIntensity, providerPUE, renewablePct, estimateWatts,
  estimateEmissionsKg, estimateEnergyKWh, carbonEquivalents,
} from '../src/common/finops-carbon';

const r = (over: any = {}) => ({
  name: 'vm', provider: 'aws', type: 'compute', region: 'us-east-1',
  status: 'running', cpuPct: 60, memoryPct: 50, monthlyCost: 100, ...over,
});

describe('common/finops-carbon', () => {
  it('maps regions to grid intensity (India dirtiest, clean Nordics, global fallback)', () => {
    expect(gridIntensity('ap-south-1', 'aws').gco2).toBe(708);
    expect(gridIntensity('mumbai', 'aws').label).toBe('India');
    expect(gridIntensity('eu-north-1', 'aws').gco2).toBeLessThan(50);
    expect(gridIntensity('zz-unknown-region', 'aws')).toEqual({ gco2: 475, label: 'Global average' });
  });

  it('PUE ordering: gcp < aws < on-prem', () => {
    expect(providerPUE('gcp')).toBeLessThan(providerPUE('aws'));
    expect(providerPUE('private')).toBeGreaterThan(providerPUE('aws'));
  });

  it('renewable coverage: hyperscalers > 0, on-prem = 0', () => {
    expect(renewablePct('aws')).toBeGreaterThan(0);
    expect(renewablePct('private')).toBe(0);
  });

  it('a stopped compute draws far less than a running one', () => {
    const running = estimateWatts(r({ status: 'running' }) as any);
    const stopped = estimateWatts(r({ status: 'stopped' }) as any);
    expect(running).toBeGreaterThan(stopped);
    expect(stopped).toBeGreaterThan(0);
  });

  it('energy and emissions are positive for a running workload', () => {
    const res = r({ region: 'ap-south-1', cpuPct: 80 }) as any;
    expect(estimateEnergyKWh(res)).toBeGreaterThan(0);
    expect(estimateEmissionsKg(res)).toBeGreaterThan(0);
  });

  it('dirtier grid yields more emissions for the same workload', () => {
    const india = estimateEmissionsKg(r({ region: 'ap-south-1' }) as any);
    const nordics = estimateEmissionsKg(r({ region: 'eu-north-1' }) as any);
    expect(india).toBeGreaterThan(nordics);
  });

  it('real-world equivalents scale with tonnage', () => {
    const e10 = carbonEquivalents(10);
    expect(e10.treeSeedlings).toBeGreaterThan(0);
    expect(carbonEquivalents(20).passengerCars).toBeGreaterThan(e10.passengerCars);
  });
});
