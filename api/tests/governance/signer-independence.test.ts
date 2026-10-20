import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SIGNER_INDEPENDENCE_POLICY,
  evaluateSignerIndependence,
} from '../../src/governance/decentralization/signer-independence';
import type { SignerProfile } from '../../src/governance/decentralization/types';

const NOW = 1_766_200_000;
const RECENT = NOW - 10 * 86_400;

function signer(overrides: Partial<SignerProfile> = {}): SignerProfile {
  return {
    address: 'GAAAA',
    organization: 'Org A',
    custody: 'hsm',
    custodyProvider: 'ledger-enterprise',
    region: 'eu-west',
    addedAt: NOW - 400 * 86_400,
    lastRotatedAt: RECENT,
    availabilityPct: 99.9,
    conflicts: [],
    ...overrides,
  };
}

const ROSTER: SignerProfile[] = [
  signer({ address: 'GAAA1', organization: 'Org A', custodyProvider: 'provider-a', region: 'eu' }),
  signer({ address: 'GAAA2', organization: 'Org B', custodyProvider: 'provider-b', region: 'us' }),
  signer({ address: 'GAAA3', organization: 'Org C', custodyProvider: 'provider-c', region: 'ap' }),
];

describe('multisig signer independence (#782)', () => {
  it('passes for pairwise-independent signers with distinct custody and organizations', () => {
    const report = evaluateSignerIndependence(ROSTER, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.verdict).toBe('pass');
    expect(report.signerCount).toBe(3);
    expect(report.independentSignerCount).toBe(3);
    expect(report.maxIndependentQuorum).toBe(3);
    expect(report.quorumReachable).toBe(true);
    expect(report.custodyDiversity.distinctProviders).toBe(3);
    expect(report.rotation.overdue).toEqual([]);
    expect(report.availability.belowPolicy).toEqual([]);
    expect(report.findings.filter((finding) => finding.severity === 'critical')).toEqual([]);
  });

  it('cannot form a quorum when every signer shares one organization', () => {
    const roster = ROSTER.map((profile, index) => ({
      ...profile,
      address: `GSHARED${index}`,
      organization: 'Same Org',
      custodyProvider: `provider-${index}`,
    }));

    const report = evaluateSignerIndependence(roster, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.verdict).toBe('fail');
    expect(report.quorumReachable).toBe(false);
    expect(report.maxIndependentQuorum).toBe(1);
    expect(report.conflictDisclosure.undisclosedSharedControl).toHaveLength(3);
    expect(
      report.findings.some((finding) => finding.code === 'INDEPENDENT_QUORUM_UNREACHABLE'),
    ).toBe(true);
  });

  it('computes the maximum independent quorum with bipartite matching, not signer count', () => {
    const roster = [
      signer({ address: 'GM1', organization: 'Org 1', custodyProvider: 'provider-1' }),
      signer({ address: 'GM2', organization: 'Org 1', custodyProvider: 'provider-2' }),
      signer({ address: 'GM3', organization: 'Org 2', custodyProvider: 'provider-1' }),
    ];

    const report = evaluateSignerIndependence(roster, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.independentSignerCount).toBe(3);
    expect(report.maxIndependentQuorum).toBe(2);
    expect(report.quorumReachable).toBe(false);
  });

  it('distinguishes disclosure from independence for same-organization signers', () => {
    const roster = [
      signer({
        address: 'GAAA1',
        organization: 'Org A',
        custodyProvider: 'provider-a',
        conflicts: [
          {
            party: 'GAAA2',
            relationship: 'employment',
            mitigation: 'Separate approval domains and independent key custody',
          },
        ],
      }),
      signer({ address: 'GAAA2', organization: 'Org A', custodyProvider: 'provider-b' }),
      signer({ address: 'GAAA3', organization: 'Org B', custodyProvider: 'provider-c' }),
    ];

    const report = evaluateSignerIndependence(roster, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.conflictDisclosure.undisclosedSharedControl).toEqual([]);
    expect(report.conflictDisclosure.declared).toBe(1);
    expect(report.independentSignerCount).toBe(3);
    // Disclosure satisfies the transparency criterion but shared control still
    // limits the independent quorum to one signer per organization.
    expect(report.maxIndependentQuorum).toBe(2);
    expect(report.verdict).toBe('fail');
  });

  it('fails closed on a conflict without a mitigation', () => {
    const roster = [
      signer({
        address: 'GAAA1',
        conflicts: [{ party: 'Acme', relationship: 'equity', mitigation: ' ' }],
      }),
      ...ROSTER.slice(1),
    ];

    const report = evaluateSignerIndependence(roster, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.signers[0].violations).toContain('CONFLICT_MITIGATION_MISSING');
    expect(report.conflictDisclosure.unmitigated).toBe(1);
  });

  it('flags overdue rotation and disallowed software custody', () => {
    const roster = [
      signer({ address: 'GOLD', lastRotatedAt: NOW - 400 * 86_400 }),
      signer({
        address: 'GSOFT',
        organization: 'Org B',
        custodyProvider: 'provider-b',
        custody: 'software',
      }),
      signer({ address: 'GAAA3', organization: 'Org C', custodyProvider: 'provider-c' }),
    ];

    const report = evaluateSignerIndependence(roster, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.rotation.overdue).toContain('GOLD');
    expect(report.signers.find((s) => s.address === 'GSOFT')?.violations).toContain(
      'CUSTODY_NOT_ALLOWED',
    );
    expect(report.independentSignerCount).toBe(1);
    expect(report.verdict).toBe('fail');
  });

  it('flags availability below policy but keeps other signers independent', () => {
    const roster = [
      signer({ address: 'GFLAKY', availabilityPct: 95 }),
      ...ROSTER.slice(1),
    ];

    const report = evaluateSignerIndependence(roster, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.availability.belowPolicy).toEqual(['GFLAKY']);
    expect(report.independentSignerCount).toBe(2);
    expect(report.quorumReachable).toBe(false);
  });

  it('reports custody-provider concentration even when a quorum is still reachable', () => {
    const roster = [
      signer({ address: 'GP1', organization: 'Org 1', custodyProvider: 'shared-kms' }),
      signer({ address: 'GP2', organization: 'Org 2', custodyProvider: 'shared-kms' }),
      signer({ address: 'GP3', organization: 'Org 3', custodyProvider: 'shared-kms' }),
      signer({ address: 'GP4', organization: 'Org 4', custodyProvider: 'provider-b' }),
      signer({ address: 'GP5', organization: 'Org 5', custodyProvider: 'provider-c' }),
    ];

    const report = evaluateSignerIndependence(roster, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.maxIndependentQuorum).toBe(3);
    expect(report.quorumReachable).toBe(true);
    expect(report.custodyDiversity.byProvider['shared-kms']).toBe(3);
    expect(
      report.findings.some((finding) => finding.code === 'CUSTODY_PROVIDER_CONCENTRATION'),
    ).toBe(true);
  });

  it('fails on a duplicate signer address', () => {
    const roster = [signer({ address: 'GDUP' }), signer({ address: 'GDUP', organization: 'Org B' })];

    const report = evaluateSignerIndependence(roster, DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW);

    expect(report.verdict).toBe('fail');
    expect(report.findings.some((finding) => finding.code === 'DUPLICATE_SIGNER_ADDRESS')).toBe(
      true,
    );
  });

  it('rejects an empty roster instead of reporting a vacuous pass', () => {
    expect(() =>
      evaluateSignerIndependence([], DEFAULT_SIGNER_INDEPENDENCE_POLICY, NOW),
    ).toThrowError(/without a signer roster/);
  });

  it('rejects an availability outside 0..100', () => {
    expect(() =>
      evaluateSignerIndependence(
        [signer({ availabilityPct: 140 })],
        DEFAULT_SIGNER_INDEPENDENCE_POLICY,
        NOW,
      ),
    ).toThrowError(/availabilityPct outside/);
  });

  it('rejects a rotation timestamp in the future', () => {
    expect(() =>
      evaluateSignerIndependence(
        [signer({ lastRotatedAt: NOW + 30 * 86_400 })],
        DEFAULT_SIGNER_INDEPENDENCE_POLICY,
        NOW,
      ),
    ).toThrowError(/rotation in the future/);
  });

  it('enforces the independent signer threshold from policy', () => {
    const report = evaluateSignerIndependence(ROSTER, {
      ...DEFAULT_SIGNER_INDEPENDENCE_POLICY,
      minIndependentSigners: 4,
    }, NOW);

    expect(report.quorumRequired).toBe(4);
    expect(report.quorumReachable).toBe(false);
    expect(report.verdict).toBe('fail');
  });
});
