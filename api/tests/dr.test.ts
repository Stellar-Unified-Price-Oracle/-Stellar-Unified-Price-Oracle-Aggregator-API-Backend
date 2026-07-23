import { describe, it, expect } from 'vitest';
import { computeRpoStatus, parseDrillResult } from '../src/services/dr-status';

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
