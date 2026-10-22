import { describe, it, expect, beforeEach } from 'vitest';
import {
  CATALOG_GUARDRAILS,
  CatalogGovernance,
  CatalogGovernanceError,
  buildOnChainPlan,
  canonicalJson,
  feedsDigest,
  validateCatalogChange,
  type CatalogPolicy,
  type CatalogPolicyChange,
  type CatalogProposal,
  type FeedPolicy,
} from '../../src/governance/catalog-policy';
import {
  impactReportDigest,
  simulateCatalogImpact,
  type ConsumerDependency,
  type ImpactSimulationInputs,
} from '../../src/governance/impact-simulator';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

let now: Date;

function advance(seconds: number): void {
  now = new Date(now.getTime() + seconds * 1000);
}

function feed(overrides: Partial<FeedPolicy> = {}): FeedPolicy {
  return {
    asset: 'XLM',
    sources: ['chainlink', 'redstone', 'band'],
    minSources: 2,
    maxDeviationBps: 150,
    stalenessSeconds: 60,
    enabled: true,
    ...overrides,
  };
}

function lowImpactChange(overrides: Partial<CatalogPolicyChange> = {}): CatalogPolicyChange {
  return {
    baseVersion: 1,
    kind: 'standard',
    upserts: [feed({ stalenessSeconds: 30 })],
    removals: [],
    ...overrides,
  };
}

const passingImpact = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  deterministicHash: 'abc',
  risk: 'low' as const,
  approvalBlocked: false,
  warnings: [] as string[],
};

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CatalogGovernanceError);
    expect((err as CatalogGovernanceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but no error was thrown`);
}

function approveAll(service: CatalogGovernance, proposal: CatalogProposal, reviewers: string[]): void {
  service.attachImpact(proposal.id, passingImpact);
  for (const reviewer of reviewers) {
    service.recordReview(proposal.id, reviewer, 'approve', { attested: true });
  }
}

function addFeedChange(): CatalogPolicyChange {
  return {
    baseVersion: 1,
    kind: 'standard',
    upserts: [
      feed({
        asset: 'SOL',
        sources: ['chainlink', 'band'],
        minSources: 2,
        maxDeviationBps: 100,
        stalenessSeconds: 60,
      }),
    ],
    removals: [],
  } as CatalogPolicyChange;
}

beforeEach(() => {
  now = new Date('2026-01-01T00:00:00.000Z');
});

describe('catalog policy guard rails (#774)', () => {
  let service: CatalogGovernance;

  beforeEach(() => {
    service = new CatalogGovernance({ now: () => now });
  });

  it('starts from a versioned genesis policy that rolls back cleanly', () => {
    const current = service.currentPolicy();
    expect(current.version).toBe(1);
    expect(current.proposalId).toBeNull();
    expect(current.feeds.map((f) => f.asset)).toEqual(['USDC', 'XLM']);
    expect(service.policyHistory()[0].digest).toBe(feedsDigest(current));
  });

  it('rejects a change authored against a stale policy version', () => {
    expectCode(
      () => service.createProposal({ proposer: 'alice', description: 'stale', change: lowImpactChange({ baseVersion: 0 }) }),
      'CATALOG_POLICY_INVALID',
    );
  });

  it('rejects changes that would break the source-diversity floor', () => {
    const validation = validateCatalogChange(service.currentPolicy(), {
      baseVersion: 1,
      kind: 'standard',
      upserts: [feed({ sources: ['chainlink'], minSources: 1 })],
      removals: [],
    });
    const codes = validation.errors.map((finding) => finding.code);
    expect(codes).toContain('INSUFFICIENT_SOURCES');
    expect(codes).toContain('MIN_SOURCES_BELOW_FLOOR');
  });

  it('rejects out-of-bounds deviation and staleness values and unknown sources', () => {
    const validation = validateCatalogChange(service.currentPolicy(), {
      baseVersion: 1,
      kind: 'standard',
      upserts: [
        feed({
          maxDeviationBps: CATALOG_GUARDRAILS.maxDeviationBps + 1,
          stalenessSeconds: CATALOG_GUARDRAILS.maxStalenessSeconds + 1,
          sources: ['chainlink', 'mystery-provider'],
        }),
      ],
      removals: [],
    });
    const codes = validation.errors.map((finding) => finding.code);
    expect(codes).toContain('DEVIATION_OUT_OF_BOUNDS');
    expect(codes).toContain('STALENESS_OUT_OF_BOUNDS');
    expect(codes).toContain('UNKNOWN_SOURCE');
  });

  it('refuses to empty the catalog or disable every feed', () => {
    const removeAll = validateCatalogChange(service.currentPolicy(), {
      baseVersion: 1,
      kind: 'standard',
      upserts: [],
      removals: ['XLM', 'USDC'],
    });
    expect(removeAll.errors.map((e) => e.code)).toContain('EMPTY_CATALOG');

    const disableAll = validateCatalogChange(service.currentPolicy(), {
      baseVersion: 1,
      kind: 'standard',
      upserts: [feed({ enabled: false }), feed({ asset: 'USDC', enabled: false })],
      removals: [],
    });
    expect(disableAll.errors.map((e) => e.code)).toContain('NO_ENABLED_FEEDS');
  });

  it('rejects a no-op change and conflicting upsert/removal pairs', () => {
    const noop = validateCatalogChange(service.currentPolicy(), {
      baseVersion: 1,
      kind: 'standard',
      upserts: [],
      removals: [],
    });
    expect(noop.errors.map((e) => e.code)).toContain('EMPTY_CHANGE');

    const same = validateCatalogChange(service.currentPolicy(), {
      baseVersion: 1,
      kind: 'standard',
      upserts: [feed()],
      removals: [],
    });
    expect(same.errors.map((e) => e.code)).toContain('NO_OP_CHANGE');

    const conflicting = validateCatalogChange(service.currentPolicy(), {
      baseVersion: 1,
      kind: 'standard',
      upserts: [feed({ stalenessSeconds: 30 })],
      removals: ['XLM'],
    });
    expect(conflicting.errors.map((e) => e.code)).toContain('CONFLICTING_CHANGE');
  });

  it('classifies loosening a guard rail as high impact with warnings', () => {
    const validation = validateCatalogChange(service.currentPolicy(), {
      baseVersion: 1,
      kind: 'standard',
      upserts: [feed({ maxDeviationBps: 300, stalenessSeconds: 120, minSources: 2 })],
      removals: [],
    });
    expect(validation.highImpact).toBe(true);
    const codes = validation.warnings.map((finding) => finding.code);
    expect(codes).toContain('DEVIATION_LOOSENED');
    expect(codes).toContain('STALENESS_LOOSENED');
  });

  it('requires three independent approvals and a 48h timelock for high-impact changes', () => {
    const proposal = service.createProposal({
      proposer: 'alice',
      description: 'list SOL',
      change: addFeedChange(),
    });
    expect(proposal.highImpact).toBe(true);
    expect(proposal.requiredApprovals).toBe(CATALOG_GUARDRAILS.highImpactApprovals);
    expect(proposal.onChainPlan.actions).toEqual([
      { action: 'SetTrustedAsset', params: { asset: 'SOL', trusted: true } },
    ]);

    approveAll(service, proposal, ['bob', 'carol']);
    expect(service.getProposal(proposal.id).status).toBe('InReview');

    service.recordReview(proposal.id, 'dave', 'approve', { attested: true });
    const approved = service.getProposal(proposal.id);
    expect(approved.status).toBe('Approved');
    expect(Date.parse(approved.timelockEndsAt as string) - now.getTime()).toBe(
      CATALOG_GUARDRAILS.highImpactTimelockSeconds * 1000,
    );
  });

  it('requires only two approvals for a change that only tightens a guard rail', () => {
    const proposal = service.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: lowImpactChange(),
    });
    expect(proposal.highImpact).toBe(false);
    expect(proposal.requiredApprovals).toBe(2);
    expect(proposal.onChainPlan.actions).toEqual([]);
    expect(proposal.onChainPlan.offChainParameters).toContain('stalenessSeconds');

    approveAll(service, proposal, ['bob', 'carol']);
    expect(service.getProposal(proposal.id).status).toBe('Approved');
  });

  it('forbids self-review, duplicate review, and review without attestation', () => {
    const proposal = service.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: lowImpactChange(),
    });

    expectCode(
      () => service.recordReview(proposal.id, 'alice', 'approve', { attested: true }),
      'SELF_REVIEW_FORBIDDEN',
    );
    expectCode(
      () => service.recordReview(proposal.id, 'bob', 'approve', { attested: false }),
      'ATTESTATION_REQUIRED',
    );

    service.attachImpact(proposal.id, passingImpact);
    service.recordReview(proposal.id, 'bob', 'approve', { attested: true });
    expectCode(
      () => service.recordReview(proposal.id, 'bob', 'approve', { attested: true }),
      'ALREADY_REVIEWED',
    );
  });

  it('blocks the final approval until an impact analysis exists and clears the gate', () => {
    const proposal = service.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: lowImpactChange(),
    });
    service.recordReview(proposal.id, 'bob', 'approve', { attested: true });
    expectCode(
      () => service.recordReview(proposal.id, 'carol', 'approve', { attested: true }),
      'IMPACT_ANALYSIS_REQUIRED',
    );

    service.attachImpact(proposal.id, { ...passingImpact, approvalBlocked: true, risk: 'critical' });
    expectCode(
      () => service.recordReview(proposal.id, 'carol', 'approve', { attested: true }),
      'IMPACT_ANALYSIS_BLOCKED',
    );

    service.attachImpact(proposal.id, passingImpact);
    expect(service.recordReview(proposal.id, 'carol', 'approve', { attested: true }).status).toBe(
      'Approved',
    );
  });

  it('records a rejection and refuses further reviews', () => {
    const proposal = service.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: lowImpactChange(),
    });
    expect(service.recordReview(proposal.id, 'bob', 'reject', { attested: true }).status).toBe(
      'Rejected',
    );
    expectCode(
      () => service.recordReview(proposal.id, 'carol', 'approve', { attested: true }),
      'PROPOSAL_NOT_IN_REVIEW',
    );
  });

  it('refuses activation before the timelock and activates as a new immutable version afterwards', () => {
    const proposal = service.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: lowImpactChange(),
    });
    approveAll(service, proposal, ['bob', 'carol']);

    expectCode(
      () => service.activate(proposal.id, 'operator', []),
      'TIMELOCK_ACTIVE',
    );
    advance(CATALOG_GUARDRAILS.timelockSeconds);

    const activated = service.activate(proposal.id, 'operator', []);
    expect(activated.status).toBe('Activated');
    expect(activated.activatedVersion).toBe(2);

    const policy = service.currentPolicy();
    expect(policy.version).toBe(2);
    expect(policy.proposalId).toBe(proposal.id);
    expect(policy.feeds.find((f) => f.asset === 'XLM')?.stalenessSeconds).toBe(30);
    expect(service.policyVersion(1).feeds.find((f) => f.asset === 'XLM')?.stalenessSeconds).toBe(60);
    expectCode(() => service.policyVersion(99), 'POLICY_VERSION_NOT_FOUND');
  });

  it('detects drift when another proposal lands between review and activation', () => {
    const first = service.createProposal({
      proposer: 'alice',
      description: 'staleness 30',
      change: lowImpactChange(),
    });
    const second = service.createProposal({
      proposer: 'alice',
      description: 'staleness 45',
      change: lowImpactChange({
        upserts: [feed({ stalenessSeconds: 45 })],
      }),
    });
    approveAll(service, first, ['bob', 'carol']);
    approveAll(service, second, ['bob', 'carol']);
    advance(CATALOG_GUARDRAILS.timelockSeconds);

    service.activate(second.id, 'operator', []);
    expectCode(() => service.activate(first.id, 'operator', []), 'POLICY_DRIFT');
  });

  it('will not activate a change for a feed under an emergency override', () => {
    const frozen = new Set<string>(['XLM']);
    const gated = new CatalogGovernance({
      now: () => now,
      isFrozen: (asset) => frozen.has(asset),
    });
    const proposal = gated.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: lowImpactChange(),
    });
    approveAll(gated, proposal, ['bob', 'carol']);
    advance(CATALOG_GUARDRAILS.timelockSeconds);

    expectCode(() => gated.activate(proposal.id, 'operator', []), 'EMERGENCY_OVERRIDE_ACTIVE');
    frozen.delete('XLM');
    expect(gated.activate(proposal.id, 'operator', []).status).toBe('Activated');
  });

  it('requires every on-chain plan action to be executed before activation', () => {
    const proposal = service.createProposal({
      proposer: 'alice',
      description: 'list SOL',
      change: addFeedChange(),
    });
    approveAll(service, proposal, ['bob', 'carol', 'dave']);
    advance(CATALOG_GUARDRAILS.highImpactTimelockSeconds);

    expectCode(() => service.activate(proposal.id, 'operator', []), 'ON_CHAIN_EXECUTION_INCOMPLETE');
    expectCode(
      () => service.activate(proposal.id, 'operator', [{ actionIndex: 3, onChainProposalId: 1 }]),
      'ON_CHAIN_EXECUTION_INVALID',
    );
    expectCode(
      () => service.activate(proposal.id, 'operator', [
        { actionIndex: 0, onChainProposalId: 1 },
        { actionIndex: 0, onChainProposalId: 2 },
      ]),
      'ON_CHAIN_EXECUTION_INVALID',
    );

    const activated = service.activate(proposal.id, 'operator', [
      { actionIndex: 0, onChainProposalId: 7 },
    ]);
    expect(activated.onChainExecutions).toEqual([{ actionIndex: 0, onChainProposalId: 7 }]);
    expect(service.currentPolicy().feeds.map((f) => f.asset)).toContain('SOL');
  });

  it('expires proposals that run out of review window and sweeps them', () => {
    const proposal = service.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: lowImpactChange(),
    });
    advance(CATALOG_GUARDRAILS.reviewWindowSeconds + 1);
    expectCode(
      () => service.recordReview(proposal.id, 'bob', 'approve', { attested: true }),
      'REVIEW_WINDOW_EXPIRED',
    );
    expect(service.getProposal(proposal.id).status).toBe('Expired');

    const second = service.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness again',
      change: lowImpactChange({ upserts: [feed({ stalenessSeconds: 20 })] }),
    });
    advance(CATALOG_GUARDRAILS.reviewWindowSeconds + 1);
    expect(service.sweepExpired()).toBe(1);
    expect(service.getProposal(second.id).status).toBe('Expired');
  });

  it('treats a rollback as an ordinary governed proposal, never a privileged shortcut', () => {
    const forward = service.createProposal({
      proposer: 'alice',
      description: 'loosen USDC deviation',
      change: {
        baseVersion: 1,
        kind: 'standard',
        upserts: [feed({ asset: 'USDC', sources: ['chainlink', 'reflector', 'band'], maxDeviationBps: 400 })],
        removals: [],
      },
    });
    approveAll(service, forward, ['bob', 'carol', 'dave']);
    advance(CATALOG_GUARDRAILS.highImpactTimelockSeconds);
    service.activate(forward.id, 'operator', []);
    expect(service.currentPolicy().feeds.find((f) => f.asset === 'USDC')?.maxDeviationBps).toBe(400);

    const rollback = service.createRollbackProposal({ proposer: 'alice', targetVersion: 1 });
    expect(rollback.change.kind).toBe('rollback');
    expect(rollback.highImpact).toBe(true);
    expect(rollback.requiredApprovals).toBe(CATALOG_GUARDRAILS.highImpactApprovals);
    expect(rollback.change.baseVersion).toBe(2);

    expectCode(() => service.activate(rollback.id, 'operator', []), 'PROPOSAL_NOT_APPROVED');

    approveAll(service, rollback, ['bob', 'carol', 'dave']);
    advance(CATALOG_GUARDRAILS.highImpactTimelockSeconds);
    const activated = service.activate(rollback.id, 'operator', []);
    expect(activated.activatedVersion).toBe(3);
    expect(service.currentPolicy().feeds.find((f) => f.asset === 'USDC')?.maxDeviationBps).toBe(50);

    expectCode(
      () => service.createRollbackProposal({ proposer: 'alice', targetVersion: 3 }),
      'ROLLBACK_TARGET_IS_LIVE',
    );
  });
});

describe('on-chain action planning (#774)', () => {
  const base: CatalogPolicy = {
    version: 1,
    activatedAt: '2026-01-01T00:00:00.000Z',
    proposalId: null,
    feeds: [
      feed({ sources: ['chainlink', 'redstone'] }),
      feed({ asset: 'USDC', sources: ['chainlink', 'reflector'], maxDeviationBps: 150 }),
    ],
  };

  it('maps feed listing changes to SetTrustedAsset and provider changes to AddSource/RemoveSource', () => {
    const plan = buildOnChainPlan(
      base,
      [
        feed({ sources: ['chainlink', 'band'] }),
        feed({ asset: 'USDC', sources: ['chainlink', 'band'] }),
        feed({ asset: 'BTC', sources: ['chainlink', 'band'] }),
      ],
      { redstone: 'GRED', reflector: 'GREF', band: 'GBAND' },
    );
    expect(plan.actions).toContainEqual({
      action: 'SetTrustedAsset',
      params: { asset: 'BTC', trusted: true },
    });
    expect(plan.actions).toContainEqual({ action: 'RemoveSource', params: { source: 'GREF' } });
    expect(plan.actions).toContainEqual({
      action: 'AddSource',
      params: { source: 'GBAND', name: 'band' },
    });
  });

  it('reports sources without a registered on-chain address instead of inventing one', () => {
    const plan = buildOnChainPlan(
      base,
      [feed({ sources: ['chainlink', 'band'] }), feed({ asset: 'USDC', sources: ['chainlink', 'reflector'] })],
      {},
    );
    expect(plan.missingSourceAddresses).toEqual(['band', 'redstone']);
    expect(plan.actions.every((action) => action.action !== 'AddSource')).toBe(true);
  });

  it('only emits SetDeviationThreshold when every enabled feed shares one value', () => {
    const uniform = buildOnChainPlan(base, [feed({ maxDeviationBps: 100 }), feed({ asset: 'USDC', sources: ['chainlink', 'reflector'], maxDeviationBps: 100 })], {});
    expect(uniform.actions).toContainEqual({
      action: 'SetDeviationThreshold',
      params: { thresholdBps: 100 },
    });

    const mixed = buildOnChainPlan(base, [feed({ maxDeviationBps: 100 }), feed({ asset: 'USDC', sources: ['chainlink', 'reflector'], maxDeviationBps: 90 })], {});
    expect(mixed.actions.some((action) => action.action === 'SetDeviationThreshold')).toBe(false);
    expect(mixed.offChainParameters).toContain('maxDeviationBps (per feed)');
  });

  it('produces a stable digest independent of input ordering', () => {
    const first = buildOnChainPlan(base, [feed(), feed({ asset: 'BTC', sources: ['band', 'chainlink'], enabled: true })], {});
    const second = buildOnChainPlan(base, [feed({ asset: 'BTC', sources: ['chainlink', 'band'], enabled: true }), feed()], {});
    expect(first.digest).toBe(second.digest);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('deterministic impact simulation (#775)', () => {
  const consumers: ConsumerDependency[] = [
    { id: 'mm-a', assets: ['XLM', 'BTC'], tier: 'pro' },
    { id: 'mm-b', assets: ['usdc'], tier: 'free' },
    { id: 'mm-c', assets: ['ETH'], tier: 'pro' },
  ];

  function inputs(overrides: Partial<ImpactSimulationInputs> = {}): ImpactSimulationInputs {
    const current: CatalogPolicy = {
      version: 1,
      activatedAt: '2026-01-01T00:00:00.000Z',
      proposalId: null,
      feeds: [feed(), feed({ asset: 'USDC', sources: ['chainlink', 'reflector'] })],
    };
    const nextFeeds = [feed({ stalenessSeconds: 120 }), feed({ asset: 'USDC', sources: ['chainlink', 'reflector'] })];
    const validation = validateCatalogChange(current, {
      baseVersion: 1,
      kind: 'standard',
      upserts: [feed({ stalenessSeconds: 120 })],
      removals: [],
    });
    return {
      current,
      nextFeeds,
      diff: validation.diff,
      findings: validation.findings,
      highImpact: validation.highImpact,
      consumers,
      costModel: {
        pollIntervalSeconds: 30,
        perSourceFetchCost: 0.001,
        perOnChainPublishCost: 0,
        currency: 'USD',
      },
      ...overrides,
    };
  }

  it('is reproducible: identical inputs produce identical hashes and reports', () => {
    const first = simulateCatalogImpact(inputs());
    const second = simulateCatalogImpact(inputs());
    expect(first.deterministicHash).toBe(second.deterministicHash);
    expect(impactReportDigest(first)).toBe(impactReportDigest(second));
  });

  it('changes the hash when the consumer dependency index changes', () => {
    const first = simulateCatalogImpact(inputs());
    const second = simulateCatalogImpact(
      inputs({ consumers: [{ id: 'mm-z', assets: ['XLM'] }] }),
    );
    expect(first.deterministicHash).not.toBe(second.deterministicHash);
  });

  it('estimates affected consumers by asset and groups them by tier', () => {
    const report = simulateCatalogImpact(inputs());
    expect(report.affectedFeeds.modified).toEqual(['XLM']);
    expect(report.affectedConsumers.total).toBe(1);
    expect(report.affectedConsumers.ids).toEqual(['mm-a']);
    expect(report.affectedConsumers.byTier).toEqual({ pro: 1 });
    expect(report.affectedConsumers.coverage).toBe('complete');
    expect(report.warnings).toContain('STALENESS_LOOSENED (XLM)');
  });

  it('flags missing consumer data rather than claiming zero exposure', () => {
    const report = simulateCatalogImpact(inputs({ consumers: [] }));
    expect(report.affectedConsumers.coverage).toBe('partial');
    expect(report.affectedConsumers.total).toBe(0);
    expect(report.warnings).toContain('NO_CONSUMER_DATA');
  });

  it('computes a cost delta from the injected cost model', () => {
    const report = simulateCatalogImpact(
      inputs({
        nextFeeds: [feed(), feed({ asset: 'USDC', sources: ['chainlink', 'reflector'] }), feed({ asset: 'BTC', sources: ['chainlink', 'band'] })],
        diff: { added: ['BTC'], removed: [], modified: [], unchanged: ['USDC', 'XLM'] },
        consumers: [],
      }),
    );
    const pollsPerDay = 86_400 / 30;
    const currentCharges = (3 + 2) * 0.001;
    const proposedCharges = (3 + 2 + 2) * 0.001;
    expect(report.cost.currentPerDay).toBeCloseTo(currentCharges * pollsPerDay, 6);
    expect(report.cost.proposedPerDay).toBeCloseTo(proposedCharges * pollsPerDay, 6);
    expect(report.cost.deltaPerDay).toBeCloseTo((proposedCharges - currentCharges) * pollsPerDay, 6);
    expect(report.cost.deltaPerMonth).toBeCloseTo(report.cost.deltaPerDay * 30, 6);
  });

  it('reports reduced safety margins and blocks approval for an unreachable feed', () => {
    const report = simulateCatalogImpact(inputs());
    expect(report.safetyMargins.reduced).toContain('stalenessHeadroomSeconds');
    expect(report.approvalBlocked).toBe(false);

    const unreachable = simulateCatalogImpact(
      inputs({
        nextFeeds: [feed({ minSources: 4, sources: ['chainlink', 'band'] })],
        diff: { added: [], removed: [], modified: ['XLM'], unchanged: ['USDC'] },
      }),
    );
    expect(unreachable.approvalBlocked).toBe(true);
    expect(unreachable.risk).toBe('critical');
  });

  it('rejects malformed cost models and duplicate consumer ids', () => {
    expect(() =>
      simulateCatalogImpact(inputs({ costModel: { pollIntervalSeconds: 0, perSourceFetchCost: 0, perOnChainPublishCost: 0 } })),
    ).toThrow(/pollIntervalSeconds/);
    expect(() =>
      simulateCatalogImpact(
        inputs({ consumers: [{ id: 'a', assets: ['XLM'] }, { id: 'a', assets: ['USDC'] }] }),
      ),
    ).toThrow(/appears more than once/);
  });
});

describe('feed freshness profiles and quote metadata (#675, #676)', () => {
  it('normalizes legacy policy entries and validates bounded named freshness settings', () => {
    const current = { version: 1, activatedAt: new Date(0).toISOString(), proposalId: null, feeds: [feed(), feed({ asset: 'USDC' })] };
    const normalized = validateCatalogChange(current, { baseVersion: 1, kind: 'standard', upserts: [feed({ stalenessSeconds: 30 })], removals: [] });
    expect(normalized.nextFeeds.find((entry) => entry.asset === 'XLM')?.freshnessProfile).toBe('standard');
    expect(normalized.nextFeeds.find((entry) => entry.asset === 'XLM')?.freshnessWarnSeconds).toBe(29);

    const invalid = validateCatalogChange(current, { baseVersion: 1, kind: 'standard', upserts: [feed({ freshnessWarnSeconds: 120 })], removals: [] });
    expect(invalid.errors.map((finding) => finding.code)).toContain('FRESHNESS_WARNING_OUT_OF_BOUNDS');
  });

  it('rejects mismatched quote denomination and out-of-range scales', () => {
    const current = { version: 1, activatedAt: new Date(0).toISOString(), proposalId: null, feeds: [feed(), feed({ asset: 'USDC' })] };
    const result = validateCatalogChange(current, {
      baseVersion: 1,
      kind: 'standard',
      upserts: [feed({ quoteUnit: { currency: 'EUR', denomination: 'USD_PER_ASSET_UNIT', scaleDecimals: 19, displayDecimals: 20, rounding: 'half-even' } })],
      removals: [],
    });
    expect(result.errors.map((finding) => finding.code)).toContain('INVALID_QUOTE_UNIT');
    expect(result.errors.map((finding) => finding.code)).toContain('INVALID_QUOTE_SCALE');
  });
});

describe('feed change impact coverage (#678)', () => {
  it('reports source quorum, API compatibility, consumers, and rollback target', () => {
    const current = { version: 3, activatedAt: new Date(0).toISOString(), proposalId: null, feeds: [feed(), feed({ asset: 'USDC' })] };
    const next = feed({ quoteUnit: { currency: 'EUR', denomination: 'EUR_PER_ASSET_UNIT', scaleDecimals: 8, displayDecimals: 2, rounding: 'half-even' } });
    const report = simulateCatalogImpact({
      current,
      nextFeeds: [next, feed({ asset: 'USDC' })],
      diff: { added: [], removed: [], modified: ['XLM'], unchanged: ['USDC'] },
      findings: [],
      highImpact: true,
      consumers: [{ id: 'vault-a', assets: ['XLM'], tier: 'production' }],
      costModel: { pollIntervalSeconds: 30, perSourceFetchCost: 0.001, perOnChainPublishCost: 0, currency: 'USD' },
    });
    expect(report.sourceQuorum[0]).toMatchObject({ asset: 'XLM', before: { quorum: 2 }, after: { quorum: 2 } });
    expect(report.apiSchemas).toContainEqual(expect.objectContaining({ asset: 'XLM', field: 'quoteUnit', impact: 'breaking' }));
    expect(report.affectedConsumers.ids).toContain('vault-a');
    expect(report.rollback.targetVersion).toBe(3);
    expect(report.rollback.steps.length).toBeGreaterThan(0);
  });
});
