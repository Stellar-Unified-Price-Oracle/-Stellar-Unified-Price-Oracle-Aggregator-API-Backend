import { describe, it, expect } from 'vitest';
import {
  computeRpoStatus,
  parseDrillResult,
  parseDependencyFailureEvidence,
  parseFailbackDrillResult,
} from '../src/services/dr-status';

describe('computeRpoStatus', () => {
  it('reports no backups as not within target', () => {
    const status = computeRpoStatus([], 300);
    expect(status.backupCount).toBe(0);
    expect(status.lastBackupAt).toBeNull();
    expect(status.ageSeconds).toBeNull();
    expect(status.withinTarget).toBe(false);
  });

  it('flags within target when the latest backup is recent enough', () => {
    const now = new Date('2026-07-23T12:00:00Z');
    const backups = [
      { createdAt: new Date('2026-07-23T11:00:00Z') },
      { createdAt: new Date('2026-07-23T11:58:00Z') },
    ];
    const status = computeRpoStatus(backups, 300, now);
    expect(status.backupCount).toBe(2);
    expect(status.ageSeconds).toBe(120);
    expect(status.withinTarget).toBe(true);
    expect(status.lastBackupAt).toBe('2026-07-23T11:58:00.000Z');
  });

  it('flags outside target when the latest backup is too old', () => {
    const now = new Date('2026-07-23T12:00:00Z');
    const backups = [{ createdAt: new Date('2026-07-22T12:00:00Z') }];
    const status = computeRpoStatus(backups, 300, now);
    expect(status.withinTarget).toBe(false);
    expect(status.ageSeconds).toBe(86400);
  });

  it('picks the most recent backup regardless of input order', () => {
    const now = new Date('2026-07-23T12:00:00Z');
    const backups = [
      { createdAt: new Date('2026-07-20T00:00:00Z') },
      { createdAt: new Date('2026-07-23T11:59:30Z') },
      { createdAt: new Date('2026-07-22T00:00:00Z') },
    ];
    const status = computeRpoStatus(backups, 300, now);
    expect(status.ageSeconds).toBe(30);
  });
});

describe('parseDrillResult', () => {
  const valid = {
    date: '2026-07-23T05:00:00Z',
    environment: 'staging',
    tier: 'tier2-full',
    rtoSeconds: 1800,
    rpoSeconds: 45,
    rtoTargetSeconds: 3600,
    rpoTargetSeconds: 300,
    passed: true,
  };

  it('accepts a well-formed drill result', () => {
    expect(parseDrillResult(valid)).toEqual(valid);
  });

  it('carries through an optional report field', () => {
    const withReport = { ...valid, report: 'drill-20260723.md' };
    expect(parseDrillResult(withReport)?.report).toBe('drill-20260723.md');
  });

  it('rejects null/non-object input', () => {
    expect(parseDrillResult(null)).toBeNull();
    expect(parseDrillResult('not an object')).toBeNull();
  });

  it('rejects an invalid tier value', () => {
    expect(parseDrillResult({ ...valid, tier: 'tier3' })).toBeNull();
  });

  it('rejects missing required fields', () => {
    const { rtoSeconds: _rtoSeconds, ...missingRto } = valid;
    expect(parseDrillResult(missingRto)).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(parseDrillResult({ ...valid, passed: 'yes' })).toBeNull();
    expect(parseDrillResult({ ...valid, rpoSeconds: '45' })).toBeNull();
  });
});

describe('parseDependencyFailureEvidence', () => {
  const valid = {
    date: '2026-07-23T06:00:00Z',
    environment: 'staging',
    dependency: 'database',
    injectedFailure: 'primary-unavailable',
    detectedSeconds: 12,
    recoveredSeconds: 240,
    recoveryTargetSeconds: 300,
    passed: true,
  };

  it('accepts well-formed evidence for each dependency type', () => {
    for (const dependency of ['database', 'cache', 'provider', 'network']) {
      const evidence = { ...valid, dependency };
      expect(parseDependencyFailureEvidence(evidence)).toEqual(evidence);
    }
  });

  it('carries through an optional report field', () => {
    const withReport = { ...valid, report: 'dep-db-20260723.md' };
    expect(parseDependencyFailureEvidence(withReport)?.report).toBe('dep-db-20260723.md');
  });

  it('rejects null/non-object input', () => {
    expect(parseDependencyFailureEvidence(null)).toBeNull();
    expect(parseDependencyFailureEvidence('not an object')).toBeNull();
  });

  it('rejects an unknown dependency', () => {
    expect(parseDependencyFailureEvidence({ ...valid, dependency: 'queue' })).toBeNull();
  });

  it('rejects a missing dependency field', () => {
    const { dependency: _dependency, ...missing } = valid;
    expect(parseDependencyFailureEvidence(missing)).toBeNull();
  });

  it('rejects missing required fields', () => {
    const { recoveredSeconds: _recovered, ...missing } = valid;
    expect(parseDependencyFailureEvidence(missing)).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(parseDependencyFailureEvidence({ ...valid, passed: 'yes' })).toBeNull();
    expect(parseDependencyFailureEvidence({ ...valid, detectedSeconds: '12' })).toBeNull();
  });

  it('rejects negative durations', () => {
    expect(parseDependencyFailureEvidence({ ...valid, detectedSeconds: -1 })).toBeNull();
    expect(parseDependencyFailureEvidence({ ...valid, recoveredSeconds: -5 })).toBeNull();
  });

  it('accepts a zero-duration exercise as a boundary case', () => {
    const zero = { ...valid, detectedSeconds: 0, recoveredSeconds: 0 };
    expect(parseDependencyFailureEvidence(zero)).toEqual(zero);
  });

  it('accepts a failed exercise and preserves the failure flag', () => {
    const failed = { ...valid, passed: false, recoveredSeconds: 900 };
    const parsed = parseDependencyFailureEvidence(failed);
    expect(parsed).toEqual(failed);
    expect(parsed?.passed).toBe(false);
  });
});

describe('parseFailbackDrillResult', () => {
  const valid = {
    date: '2026-07-23T08:00:00Z',
    environment: 'staging',
    fromRegion: 'us-east-1',
    toRegion: 'us-west-2',
    stabilityWindowSeconds: 600,
    reconcileSeconds: 120,
    trafficShiftSeconds: 90,
    splitBrainDetected: false,
    passed: true,
  };

  it('accepts a well-formed failback drill result', () => {
    expect(parseFailbackDrillResult(valid)).toEqual(valid);
  });

  it('carries through an optional report field', () => {
    const withReport = { ...valid, report: 'failback-20260723.md' };
    expect(parseFailbackDrillResult(withReport)?.report).toBe('failback-20260723.md');
  });

  it('rejects null/non-object input', () => {
    expect(parseFailbackDrillResult(null)).toBeNull();
    expect(parseFailbackDrillResult('not an object')).toBeNull();
  });

  it('rejects missing required fields', () => {
    const { toRegion: _toRegion, ...missing } = valid;
    expect(parseFailbackDrillResult(missing)).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(parseFailbackDrillResult({ ...valid, splitBrainDetected: 'no' })).toBeNull();
    expect(parseFailbackDrillResult({ ...valid, reconcileSeconds: '120' })).toBeNull();
  });

  it('rejects negative durations', () => {
    expect(parseFailbackDrillResult({ ...valid, stabilityWindowSeconds: -1 })).toBeNull();
  });

  it('accepts a zero-duration stability window as a boundary case', () => {
    const zero = { ...valid, stabilityWindowSeconds: 0 };
    expect(parseFailbackDrillResult(zero)).toEqual(zero);
  });

  it('accepts a failed failback and preserves the failure flag', () => {
    const failed = { ...valid, passed: false, splitBrainDetected: true };
    const parsed = parseFailbackDrillResult(failed);
    expect(parsed).toEqual(failed);
    expect(parsed?.passed).toBe(false);
    expect(parsed?.splitBrainDetected).toBe(true);
  });
});
