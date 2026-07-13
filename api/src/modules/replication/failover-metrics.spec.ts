import { computeRpoSeconds, computeRtoSeconds, deriveOutcome, parseDrbdRole } from './failover-metrics';

describe('failover-metrics (pure RTO/RPO/outcome, deterministic)', () => {
  const T0 = new Date('2026-07-12T10:00:00.000Z');

  describe('computeRpoSeconds', () => {
    test('data-loss window = trigger − lastOkAt, rounded to seconds', () => {
      const lastOk = new Date('2026-07-12T09:59:30.000Z'); // 30s before trigger
      expect(computeRpoSeconds(lastOk, T0)).toBe(30);
    });

    test('sub-second replication lag rounds to whole seconds', () => {
      const lastOk = new Date('2026-07-12T09:59:58.400Z'); // 1.6s
      expect(computeRpoSeconds(lastOk, T0)).toBe(2);
    });

    test('never negative when lastOkAt is (impossibly) after trigger', () => {
      const lastOk = new Date('2026-07-12T10:00:05.000Z');
      expect(computeRpoSeconds(lastOk, T0)).toBe(0);
    });

    test('null when the set never replicated successfully (unknown, not zero)', () => {
      expect(computeRpoSeconds(null, T0)).toBeNull();
      expect(computeRpoSeconds(undefined, T0)).toBeNull();
    });
  });

  describe('computeRtoSeconds', () => {
    test('recovery time = verifiedAt − triggeredAt', () => {
      const verified = new Date('2026-07-12T10:00:47.000Z'); // 47s to recover
      expect(computeRtoSeconds(T0, verified)).toBe(47);
    });

    test('null when the new primary was never verified', () => {
      expect(computeRtoSeconds(T0, null)).toBeNull();
      expect(computeRtoSeconds(T0, undefined)).toBeNull();
    });

    test('clamps to 0 on out-of-order stamps', () => {
      expect(computeRtoSeconds(T0, new Date('2026-07-12T09:59:59.000Z'))).toBe(0);
    });
  });

  describe('parseDrbdRole', () => {
    test('modern drbdadm status tree: local Primary + UpToDate, peer Secondary', () => {
      const status = [
        'mcmfab12cd34 role:Primary',
        '  disk:UpToDate',
        '  peer role:Secondary',
        '    replication:Established peer-disk:UpToDate',
      ].join('\n');
      expect(parseDrbdRole(status)).toEqual({ primary: true, upToDate: true });
    });

    test('local Secondary is NOT reported as primary even when peer is Primary', () => {
      const status = [
        'mcmfab12cd34 role:Secondary',
        '  disk:UpToDate',
        '  peer role:Primary',
      ].join('\n');
      expect(parseDrbdRole(status).primary).toBe(false);
    });

    test('legacy /proc/drbd style (ro:/ds:)', () => {
      const status = 'cs:Connected ro:Primary/Secondary ds:UpToDate/UpToDate';
      expect(parseDrbdRole(status)).toEqual({ primary: true, upToDate: true });
    });

    test('promoted but still syncing → primary, disk not confirmed UpToDate', () => {
      const status = 'mcmfab12cd34 role:Primary\n  disk:Inconsistent\n  peer role:Secondary';
      expect(parseDrbdRole(status)).toEqual({ primary: true, upToDate: false });
    });

    test('empty / garbage input is safe', () => {
      expect(parseDrbdRole('')).toEqual({ primary: false, upToDate: false });
      expect(parseDrbdRole(undefined as any)).toEqual({ primary: false, upToDate: false });
    });
  });

  describe('deriveOutcome', () => {
    test('block: promoted + Primary + UpToDate + healthy → success', () => {
      expect(deriveOutcome({ promoted: true, isBlock: true, drbdPrimary: true, drbdUpToDate: true, healthChecked: true, healthOk: true })).toBe('success');
    });

    test('block: Primary + UpToDate but host unreachable → partial', () => {
      expect(deriveOutcome({ promoted: true, isBlock: true, drbdPrimary: true, drbdUpToDate: true, healthChecked: true, healthOk: false })).toBe('partial');
    });

    test('block: Primary but disk not UpToDate → partial', () => {
      expect(deriveOutcome({ promoted: true, isBlock: true, drbdPrimary: true, drbdUpToDate: false, healthChecked: true, healthOk: true })).toBe('partial');
    });

    test('block: promote command ran but node never took Primary role → failed', () => {
      expect(deriveOutcome({ promoted: true, isBlock: true, drbdPrimary: false, drbdUpToDate: false, healthChecked: true, healthOk: true })).toBe('failed');
    });

    test('promotion itself did not complete → failed regardless of signals', () => {
      expect(deriveOutcome({ promoted: false, isBlock: true, drbdPrimary: true, drbdUpToDate: true, healthChecked: true, healthOk: true })).toBe('failed');
    });

    test('non-block: promoted + health check passes → success', () => {
      expect(deriveOutcome({ promoted: true, isBlock: false, drbdPrimary: false, drbdUpToDate: false, healthChecked: true, healthOk: true })).toBe('success');
    });

    test('non-block: promoted but health check fails → partial', () => {
      expect(deriveOutcome({ promoted: true, isBlock: false, drbdPrimary: false, drbdUpToDate: false, healthChecked: true, healthOk: false })).toBe('partial');
    });

    test('non-block: promoted with no health check performed → success', () => {
      expect(deriveOutcome({ promoted: true, isBlock: false, drbdPrimary: false, drbdUpToDate: false, healthChecked: false, healthOk: false })).toBe('success');
    });
  });

  describe('end-to-end trial arithmetic (thesis evidence)', () => {
    test('a full simulated trial yields real RTO/RPO numbers', () => {
      const lastOk = new Date('2026-07-12T09:59:45.000Z'); // last good replication 15s before failure
      const triggeredAt = T0;
      const verifiedAt = new Date('2026-07-12T10:00:38.000Z'); // recovered in 38s
      const rpo = computeRpoSeconds(lastOk, triggeredAt);
      const rto = computeRtoSeconds(triggeredAt, verifiedAt);
      const outcome = deriveOutcome({ promoted: true, isBlock: true, drbdPrimary: true, drbdUpToDate: true, healthChecked: true, healthOk: true });
      expect(rpo).toBe(15);
      expect(rto).toBe(38);
      expect(outcome).toBe('success');
    });
  });
});
