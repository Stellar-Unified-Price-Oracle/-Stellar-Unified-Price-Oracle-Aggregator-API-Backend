import { describe, it, expect, beforeEach } from 'vitest';
import {
  COI_LIMITS,
  CoiError,
  CoiRegister,
} from '../../src/governance/coi-register';
import {
  EMERGENCY_LIMITS,
  EmergencyActionError,
  EmergencyActionRegistry,
} from '../../src/governance/emergency-actions';
import {
  CATALOG_GUARDRAILS,
  CatalogGovernance,
  CatalogGovernanceError,
  type FeedPolicy,
} from '../../src/governance/catalog-policy';

const HOUR = 60 * 60;

let now: Date;

function advance(seconds: number): void {
  now = new Date(now.getTime() + seconds * 1000);
}

function expectCoiError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CoiError);
    expect((err as CoiError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but no error was thrown`);
}

function expectEmergencyError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EmergencyActionError);
    expect((err as EmergencyActionError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but no error was thrown`);
}

function expectCatalogError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CatalogGovernanceError);
    expect((err as CatalogGovernanceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but no error was thrown`);
}

function catalogFeed(overrides: Partial<FeedPolicy> = {}): FeedPolicy {
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

beforeEach(() => {
  now = new Date('2026-01-01T00:00:00.000Z');
});

describe('conflict-of-interest register (#776)', () => {
  let coi: CoiRegister;

  beforeEach(() => {
    coi = new CoiRegister({ now: () => now });
  });

  it('requires an attested disclosure and validates the relationship and scope', () => {
    expectCoiError(
      () =>
        coi.declare({
          actor: 'alice',
          relationship: 'financial',
          counterparty: 'chainlink',
          scope: 'source',
          attested: false,
        }),
      'ATTESTATION_REQUIRED',
    );
    expectCoiError(
      () =>
        coi.declare({
          actor: 'alice',
          relationship: 'bribery',
          counterparty: 'chainlink',
          scope: 'source',
          attested: true,
        }),
      'INVALID_RELATIONSHIP',
    );
    expectCoiError(
      () =>
        coi.declare({
          actor: 'alice',
          relationship: 'other',
          counterparty: 'chainlink',
          scope: 'source',
          attested: true,
        }),
      'DETAILS_REQUIRED',
    );
  });

  it('bounds declaration validity so coverage cannot be claimed forever', () => {
    expectCoiError(
      () =>
        coi.declare({
          actor: 'alice',
          relationship: 'financial',
          counterparty: 'chainlink',
          scope: 'source',
          attested: true,
          expiresAt: now.toISOString(),
        }),
      'EXPIRY_IN_PAST',
    );
    expectCoiError(
      () =>
        coi.declare({
          actor: 'alice',
          relationship: 'financial',
          counterparty: 'chainlink',
          scope: 'source',
          attested: true,
          expiresAt: new Date(now.getTime() + (COI_LIMITS.maxDisclosureSeconds + 60) * 1000).toISOString(),
        }),
      'EXPIRY_TOO_FAR',
    );
  });

  it('rejects duplicate active declarations and lets the owner withdraw', () => {
    const disclosure = coi.declare({
      actor: 'alice',
      relationship: 'financial',
      counterparty: 'chainlink',
      scope: 'source',
      details: 'consulting retainer',
      attested: true,
    });
    expectCoiError(
      () =>
        coi.declare({
          actor: 'alice',
          relationship: 'financial',
          counterparty: 'Chainlink',
          scope: 'source',
          attested: true,
        }),
      'DUPLICATE_DISCLOSURE',
    );
    expectCoiError(() => coi.withdraw(disclosure.id, 'mallory'), 'NOT_DISCLOSURE_OWNER');

    expect(coi.withdraw(disclosure.id, 'alice').status).toBe('withdrawn');
    expect(coi.list({ actor: 'alice' })[0].status).toBe('withdrawn');
    expect(
      coi.declare({
        actor: 'alice',
        relationship: 'financial',
        counterparty: 'chainlink',
        scope: 'source',
        attested: true,
      }).status,
    ).toBe('active');
  });

  it('recuses an actor for asset, provider and protocol-wide conflicts', () => {
    coi.declare({
      actor: 'reviewer',
      relationship: 'token-holding',
      counterparty: 'xlm',
      scope: 'asset',
      attested: true,
    });
    coi.declare({
      actor: 'reviewer',
      relationship: 'employment',
      counterparty: 'chainlink',
      scope: 'source',
      attested: true,
    });

    expect(coi.recusalReasons('reviewer', { assets: ['XLM'], sources: [] })).toHaveLength(1);
    expect(coi.recusalReasons('reviewer', { assets: [], sources: ['redstone'] })).toHaveLength(0);
    expect(coi.recusalReasons('reviewer', { assets: ['XLM'], sources: ['chainlink'] })).toHaveLength(2);
    expect(coi.recusalReasons('someone-else', { assets: ['XLM'], sources: ['chainlink'] })).toHaveLength(0);

    coi.declare({
      actor: 'board-member',
      relationship: 'financial',
      counterparty: 'protocol',
      scope: 'protocol',
      attested: true,
    });
    expect(coi.recusalReasons('board-member', { assets: ['BTC'], sources: [] })).toHaveLength(1);
  });

  it('keeps recusing on an expired declaration until it is re-declared', () => {
    coi.declare({
      actor: 'reviewer',
      relationship: 'financial',
      counterparty: 'XLM',
      scope: 'asset',
      attested: true,
      expiresAt: new Date(now.getTime() + HOUR * 1000).toISOString(),
    });
    advance(HOUR + 1);
    expect(coi.list()[0].status).toBe('expired');
    expect(coi.recusalReasons('reviewer', { assets: ['XLM'], sources: [] })[0]).toMatch(/expired/);
  });

  it('expires attestations and fails eligibility closed', () => {
    coi.attest('reviewer');
    expect(coi.checkEligibility('reviewer', { assets: ['XLM'], sources: [] }).eligible).toBe(true);

    advance(COI_LIMITS.attestationValiditySeconds + 1);
    const eligibility = coi.checkEligibility('reviewer', { assets: ['XLM'], sources: [] });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.code).toBe('ATTESTATION_REQUIRED');

    coi.attest('reviewer', 'no new relationships');
    expect(coi.checkEligibility('reviewer', { assets: ['XLM'], sources: [] }).eligible).toBe(true);
  });

  it('blocks a recused reviewer from approving a catalog change', () => {
    const coiRegister = new CoiRegister({ now: () => now });
    const catalog = new CatalogGovernance({
      now: () => now,
      isRecused: (actor, request) => coiRegister.recusalReasons(actor, request),
    });
    coiRegister.declare({
      actor: 'bob',
      relationship: 'employment',
      counterparty: 'chainlink',
      scope: 'source',
      attested: true,
    });
    coiRegister.attest('bob');
    coiRegister.attest('carol');

    const proposal = catalog.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: {
        baseVersion: 1,
        kind: 'standard',
        upserts: [catalogFeed({ stalenessSeconds: 30 })],
        removals: [],
      },
    });

    expectCatalogError(
      () => catalog.recordReview(proposal.id, 'bob', 'approve', { attested: true }),
      'CONFLICT_OF_INTEREST',
    );

    catalog.attachImpact(proposal.id, {
      generatedAt: now.toISOString(),
      deterministicHash: 'hash',
      risk: 'low',
      approvalBlocked: false,
      warnings: [],
    });
    expect(
      catalog.recordReview(proposal.id, 'carol', 'approve', { attested: true }).reviews,
    ).toHaveLength(1);
  });
});

describe('emergency actions with expiry, review and disclosure (#778)', () => {
  let emergency: EmergencyActionRegistry;

  beforeEach(() => {
    emergency = new EmergencyActionRegistry({ now: () => now, currentPolicyVersion: () => 7 });
  });

  it('refuses emergency actions that would expand rather than restrict', () => {
    expectEmergencyError(
      () => emergency.open({ kind: 'add-feed', reason: 'ship it', actor: 'alice', asset: 'BTC', durationSeconds: 60 }),
      'EMERGENCY_KIND_NOT_PERMITTED',
    );
    expect(EmergencyActionRegistry.prohibitedKinds()).toContain('loosen-guardrail');
    expect(EmergencyActionRegistry.allowedKinds()).toEqual([
      'pause-feed',
      'freeze-source',
      'halt-publishing',
    ]);
  });

  it('requires an explicit expiry within the 72-hour bound', () => {
    expectEmergencyError(
      () => emergency.open({ kind: 'pause-feed', reason: 'bad data', actor: 'alice', asset: 'XLM' }),
      'EXPIRY_REQUIRED',
    );
    expectEmergencyError(
      () =>
        emergency.open({
          kind: 'pause-feed',
          reason: 'bad data',
          actor: 'alice',
          asset: 'XLM',
          durationSeconds: EMERGENCY_LIMITS.maxDurationSeconds + 1,
        }),
      'EXPIRY_TOO_FAR',
    );
  });

  it('scopes each action kind and refuses duplicate open actions', () => {
    expectEmergencyError(
      () => emergency.open({ kind: 'pause-feed', reason: 'bad data', actor: 'alice', durationSeconds: 60 }),
      'SCOPE_REQUIRED',
    );
    const action = emergency.open({
      kind: 'pause-feed',
      reason: 'bad data',
      actor: 'alice',
      asset: 'xlm',
      durationSeconds: 3600,
    });
    expect(action.asset).toBe('XLM');
    expect(action.policyVersionAtCreation).toBe(7);
    expect(action.disclosure).toEqual({ required: true });

    expectEmergencyError(
      () =>
        emergency.open({
          kind: 'pause-feed',
          reason: 'duplicate',
          actor: 'bob',
          asset: 'XLM',
          durationSeconds: 3600,
        }),
      'DUPLICATE_EMERGENCY_ACTION',
    );
  });

  it('requires an independent, attested reviewer within the review window', () => {
    const action = emergency.open({
      kind: 'pause-feed',
      reason: 'bad data',
      actor: 'alice',
      asset: 'XLM',
      durationSeconds: EMERGENCY_LIMITS.reviewWindowSeconds * 2,
    });

    expectEmergencyError(
      () => emergency.review(action.id, 'alice', { decision: 'confirm', attested: true }),
      'INDEPENDENT_REVIEW_REQUIRED',
    );
    expectEmergencyError(
      () => emergency.review(action.id, 'bob', { decision: 'confirm', attested: false }),
      'ATTESTATION_REQUIRED',
    );

    advance(EMERGENCY_LIMITS.reviewWindowSeconds + 1);
    expectEmergencyError(
      () => emergency.review(action.id, 'bob', { decision: 'confirm', attested: true }),
      'REVIEW_DEADLINE_PASSED',
    );
    expect(emergency.get(action.id).reviewOverdue).toBe(true);
    expect(emergency.overdueReviews().map((entry) => entry.id)).toEqual([action.id]);
  });

  it('records an independent review and lets a reviewer overturn the action', () => {
    const confirmed = emergency.open({
      kind: 'pause-feed',
      reason: 'bad data',
      actor: 'alice',
      asset: 'XLM',
      durationSeconds: 7200,
    });
    expect(
      emergency.review(confirmed.id, 'bob', { decision: 'confirm', attested: true }).status,
    ).toBe('Reviewed');

    const overturned = emergency.open({
      kind: 'freeze-source',
      reason: 'provider compromise',
      actor: 'alice',
      source: 'redstone',
      durationSeconds: 7200,
    });
    expect(emergency.isSourceFrozen('redstone')).toBe(true);
    expect(
      emergency.review(overturned.id, 'bob', { decision: 'overturn', attested: true }).status,
    ).toBe('Revoked');
    expect(emergency.isSourceFrozen('redstone')).toBe(false);
  });

  it('only renews a reviewed action, within per-window and cumulative caps, and re-review is required', () => {
    const action = emergency.open({
      kind: 'pause-feed',
      reason: 'bad data',
      actor: 'alice',
      asset: 'XLM',
      durationSeconds: EMERGENCY_LIMITS.maxDurationSeconds,
    });

    expectEmergencyError(
      () =>
        emergency.renew(action.id, 'alice', {
          durationSeconds: EMERGENCY_LIMITS.maxDurationSeconds,
        }),
      'REVIEW_REQUIRED_BEFORE_RENEWAL',
    );

    emergency.review(action.id, 'bob', { decision: 'confirm', attested: true });
    advance(HOUR);
    expectEmergencyError(
      () =>
        emergency.renew(action.id, 'alice', {
          durationSeconds: EMERGENCY_LIMITS.maxDurationSeconds * 2 + HOUR,
        }),
      'RENEWAL_TOO_LONG',
    );

    const renewed = emergency.renew(action.id, 'alice', {
      durationSeconds: EMERGENCY_LIMITS.maxDurationSeconds,
    });
    expect(renewed.renewals).toBe(1);
    expect(renewed.status).toBe('Active');
    expect(renewed.reviewer).toBeUndefined();
    expect(renewed.expiresAt).toBe(
      new Date(now.getTime() + EMERGENCY_LIMITS.maxDurationSeconds * 1000).toISOString(),
    );

    advance(HOUR);
    emergency.review(action.id, 'bob', { decision: 'confirm', attested: true });
    expect(
      emergency.renew(action.id, 'alice', { durationSeconds: EMERGENCY_LIMITS.maxDurationSeconds })
        .renewals,
    ).toBe(2);
    advance(HOUR);
    emergency.review(action.id, 'bob', { decision: 'confirm', attested: true });
    expectEmergencyError(
      () => emergency.renew(action.id, 'alice', { durationSeconds: 60 }),
      'RENEWAL_LIMIT_REACHED',
    );
  });

  it('expires actions, releases their overlays and flags unreviewed closures', () => {
    const reviewed = emergency.open({
      kind: 'pause-feed',
      reason: 'bad data',
      actor: 'alice',
      asset: 'XLM',
      durationSeconds: 3600,
    });
    emergency.review(reviewed.id, 'bob', { decision: 'confirm', attested: true });

    const unreviewed = emergency.open({
      kind: 'halt-publishing',
      reason: 'provider outage',
      actor: 'alice',
      durationSeconds: 3600,
    });

    expect(emergency.isFrozen('XLM')).toBe(true);
    advance(3601);
    expect(emergency.sweep()).toBe(2);
    expect(emergency.get(reviewed.id).status).toBe('Expired');
    expect(emergency.get(unreviewed.id).status).toBe('ExpiredUnreviewed');
    expect(emergency.isFrozen('XLM')).toBe(false);
    expect(emergency.activeOverlays().halted).toBe(false);
  });

  it('requires post-action disclosure after the action closes, and flags overdue disclosures', () => {
    const action = emergency.open({
      kind: 'freeze-source',
      reason: 'provider compromise',
      actor: 'alice',
      source: 'band',
      durationSeconds: 3600,
    });

    expectEmergencyError(
      () => emergency.publishDisclosure(action.id, { summary: 'too early', actor: 'bob' }),
      'DISCLOSURE_BEFORE_CLOSE',
    );

    advance(3601);
    expect(emergency.get(action.id).status).toBe('ExpiredUnreviewed');
    const disclosed = emergency.publishDisclosure(action.id, {
      summary: 'Froze Band for 1h after a stale-price report; no consumer impact.',
      actor: 'bob',
    });
    expect(disclosed.disclosure.publishedAt).toBe(now.toISOString());

    const overdue = emergency.open({
      kind: 'halt-publishing',
      reason: 'provider outage',
      actor: 'alice',
      durationSeconds: 3600,
    });
    advance(3601 + EMERGENCY_LIMITS.disclosureWindowSeconds + 1);
    expect(emergency.overdueDisclosures().map((entry) => entry.id)).toEqual([overdue.id]);
  });

  it('blocks catalog activation while a feed is frozen and allows it after expiry', () => {
    const coi = new CoiRegister({ now: () => now });
    const emergencyRegister = new EmergencyActionRegistry({ now: () => now });
    const catalog = new CatalogGovernance({
      now: () => now,
      isFrozen: (asset) => emergencyRegister.isFrozen(asset),
      isRecused: (actor, request) => coi.recusalReasons(actor, request),
    });

    emergencyRegister.open({
      kind: 'pause-feed',
      reason: 'bad data',
      actor: 'alice',
      asset: 'XLM',
      durationSeconds: 2 * CATALOG_GUARDRAILS.timelockSeconds,
    });

    const proposal = catalog.createProposal({
      proposer: 'alice',
      description: 'tighten XLM staleness',
      change: {
        baseVersion: 1,
        kind: 'standard',
        upserts: [catalogFeed({ stalenessSeconds: 30 })],
        removals: [],
      },
    });
    catalog.attachImpact(proposal.id, {
      generatedAt: now.toISOString(),
      deterministicHash: 'hash',
      risk: 'low',
      approvalBlocked: false,
      warnings: [],
    });
    catalog.recordReview(proposal.id, 'bob', 'approve', { attested: true });
    catalog.recordReview(proposal.id, 'carol', 'approve', { attested: true });
    advance(CATALOG_GUARDRAILS.timelockSeconds);

    expectCatalogError(() => catalog.activate(proposal.id, 'operator', []), 'EMERGENCY_OVERRIDE_ACTIVE');

    advance(CATALOG_GUARDRAILS.timelockSeconds);
    expect(catalog.activate(proposal.id, 'operator', []).status).toBe('Activated');
  });
});
