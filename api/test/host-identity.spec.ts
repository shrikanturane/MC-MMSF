import { hostIps, isHostResource, liveHostStatus, buildMonByIp, mergeHostResources } from '../src/common/host-identity';

describe('common/host-identity', () => {
  it('isHostResource is true only for linux/windows', () => {
    expect(isHostResource({ provider: 'linux' } as any)).toBe(true);
    expect(isHostResource({ provider: 'windows' } as any)).toBe(true);
    expect(isHostResource({ provider: 'aws' } as any)).toBe(false);
  });

  it('hostIps extracts routable IPs and excludes loopback / docker-bridge', () => {
    const ips = hostIps({ name: '10.0.0.5', properties: { ips: '10.0.0.5, 127.0.0.1, 172.17.0.2, 192.168.1.9' } } as any);
    expect(ips).toContain('10.0.0.5');
    expect(ips).toContain('192.168.1.9');
    expect(ips).not.toContain('127.0.0.1');
    expect(ips).not.toContain('172.17.0.2');
  });

  it('liveHostStatus: fresh heartbeat = running, stale = stopped', () => {
    const mon = new Map<string, string>();
    expect(liveHostStatus({ name: 'h', provider: 'linux', lastSeenAt: new Date() } as any, mon)).toBe('running');
    expect(liveHostStatus({ name: 'h', provider: 'linux', lastSeenAt: new Date(Date.now() - 10 * 60_000) } as any, mon)).toBe('stopped');
  });

  it('liveHostStatus: an up monitor keeps a silent host running', () => {
    const mon = buildMonByIp([{ target: '10.0.0.5', status: 'up' }]);
    const host = { name: '10.0.0.5', provider: 'linux', properties: { ips: '10.0.0.5' } } as any;
    expect(liveHostStatus(host, mon)).toBe('running');
  });

  it('buildMonByIp treats "up" as authoritative over "down"', () => {
    const m = buildMonByIp([{ target: '10.0.0.5', status: 'down' }, { target: '10.0.0.5', status: 'up' }]);
    expect(m.get('10.0.0.5')).toBe('up');
  });

  it('mergeHostResources collapses the same host seen under hostname + IP', () => {
    const rows = [
      { id: 'a', name: 'host1', provider: 'linux', properties: { ips: '10.0.0.5' }, lastSeenAt: new Date() },
      { id: 'b', name: '10.0.0.5', provider: 'linux', properties: { ips: '10.0.0.5' } },
    ] as any[];
    expect(mergeHostResources(rows).length).toBe(1);
  });

  it('mergeHostResources leaves cloud VMs untouched', () => {
    const rows = [
      { id: 'a', name: 'ec2-a', provider: 'aws', properties: { ips: '10.0.0.5' } },
      { id: 'b', name: 'ec2-b', provider: 'aws', properties: { ips: '10.0.0.5' } },
    ] as any[];
    expect(mergeHostResources(rows).length).toBe(2);
  });
});
