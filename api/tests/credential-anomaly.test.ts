import { describe, it, expect } from 'vitest';
import { CredentialAnomalyDetector, credentialRef } from '../src/security/credentialAnomaly';

const T0 = 1_700_000_000_000;
const ev = (over: Partial<Parameters<CredentialAnomalyDetector['observe']>[0]> = {}) => ({
  credentialId: 'key-abc',
  timestamp: T0,
  country: 'NG',
  endpoint: '/api/v2/prices/:asset',
  privilege: 'read',
  ...over,
});

function warm(d: CredentialAnomalyDetector, n = 20) {
  for (let i = 0; i < n; i++) d.observe(ev({ timestamp: T0 + i * 1000 }));
}

describe('CredentialAnomalyDetector', () => {
  it('raises no alerts during warmup, even for novel behaviour', () => {
    const d = new CredentialAnomalyDetector();
    expect(d.observe(ev({ country: 'NG' }))).toEqual([]);
    expect(d.observe(ev({ country: 'RU', privilege: 'admin', endpoint: '/admin' }))).toEqual([]);
  });

  it('flags new geography after warmup, once', () => {
    const d = new CredentialAnomalyDetector();
    warm(d);
    const a = d.observe(ev({ timestamp: T0 + 30_000, country: 'RU' }));
    expect(a.map((x) => x.kind)).toEqual(['new_geography']);
    expect(d.observe(ev({ timestamp: T0 + 31_000, country: 'RU' }))).toEqual([]);
  });

  it('flags new endpoint pattern and privilege escalation', () => {
    const d = new CredentialAnomalyDetector();
    warm(d);
    const kinds = d.observe(ev({ timestamp: T0 + 30_000, endpoint: '/api/v2/admin/keys', privilege: 'admin' })).map((x) => x.kind);
    expect(kinds).toContain('new_endpoint_pattern');
    expect(kinds).toContain('privilege_escalation');
  });

  it('flags abrupt usage spikes against baseline', () => {
    const d = new CredentialAnomalyDetector({ warmupEvents: 5, spikeMinCount: 30 });
    // Baseline: 10 events in the first window.
    for (let i = 0; i < 10; i++) d.observe(ev({ timestamp: T0 + i * 1000 }));
    // Next window: burst of 60.
    let spike = false;
    for (let i = 0; i < 60; i++) {
      if (d.observe(ev({ timestamp: T0 + 61_000 + i })).some((x) => x.kind === 'usage_spike')) spike = true;
    }
    expect(spike).toBe(true);
  });

  it('does not flag steady usage below the minimum spike count', () => {
    const d = new CredentialAnomalyDetector({ warmupEvents: 2 });
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 5; i++) {
        expect(d.observe(ev({ timestamp: T0 + w * 61_000 + i })).filter((x) => x.kind === 'usage_spike')).toEqual([]);
      }
    }
  });

  it('never exposes the credential id in alerts', () => {
    const d = new CredentialAnomalyDetector();
    warm(d);
    const a = d.observe(ev({ timestamp: T0 + 30_000, country: 'RU' }));
    expect(JSON.stringify(a)).not.toContain('key-abc');
    expect(a[0].credentialRef).toBe(credentialRef('key-abc'));
  });

  it('reset clears learned state and evicts beyond maxCredentials', () => {
    const d = new CredentialAnomalyDetector({ maxCredentials: 1 });
    warm(d);
    d.reset('key-abc');
    expect(d.observe(ev({ country: 'RU' }))).toEqual([]);
    d.observe(ev({ credentialId: 'other' }));
    expect(d.observe(ev({ country: 'RU' }))).toEqual([]);
  });
});
