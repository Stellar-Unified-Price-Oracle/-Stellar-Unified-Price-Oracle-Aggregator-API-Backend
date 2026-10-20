/**
 * Governed feed-catalog policy (#774).
 *
 * A catalog policy is the immutable, versioned record of which feeds this
 * oracle publishes, which providers back each feed, and the guard rails
 * (minimum sources, deviation threshold, staleness bound) those feeds run
 * under. Policy changes never mutate a live policy: a change is proposed
 * against an exact base version, independently reviewed, timelocked, and only
 * then activated as a new immutable version. The previous versions stay
 * readable so a rollback is a normal governed proposal, not a privileged
 * escape hatch.
 *
 * Safety controls that cannot be bypassed:
 *   - a change names the policy version it was authored against; if the live
 *     policy has moved on, activation fails instead of silently re-basing
 *   - guard rails are re-validated at activation, not only at proposal time
 *   - high-impact changes (feed added/removed/disabled, guard rail loosened)
 *     need three independent approvals and a longer timelock
 *   - a reviewer with a conflict of interest or an expired attestation cannot
 *     approve (COI register is injected; see `coi-register.ts`)
 *   - a proposal touching a feed under an active emergency override cannot be
 *     activated until the override is closed or expires
 *   - every on-chain action in the plan must be executed by a multisig
 *     proposal before the API activates the policy (verified by the routes)
 */

import crypto from 'crypto';
import type { RecusalRequest } from './coi-register';

export const CATALOG_SOURCES = ['chainlink', 'redstone', 'band', 'reflector'] as const;

export interface FeedPolicy {
  /** Upper-case asset ticker, e.g. `XLM`. */
  asset: string;
  /** Provider names backing the feed. */
  sources: string[];
  /** Minimum independent providers required before a price is published. */
  minSources: number;
  /** Maximum allowed deviation from the previous published price. */
  maxDeviationBps: number;
  /** Age after which a source value is considered stale. */
  stalenessSeconds: number;
  enabled: boolean;
}

export interface CatalogPolicy {
  version: number;
  activatedAt: string;
  /** Proposal that produced this version; `null` for the genesis policy. */
  proposalId: number | null;
  feeds: FeedPolicy[];
}

export type CatalogChangeKind = 'standard' | 'rollback';

export interface CatalogPolicyChange {
  /** Live policy version this change was authored against. */
  baseVersion: number;
  kind: CatalogChangeKind;
  upserts: FeedPolicy[];
  removals: string[];
}

export const CATALOG_GUARDRAILS = {
  minSourceCount: 2,
  minDeviationBps: 10,
  maxDeviationBps: 2000,
  minStalenessSeconds: 10,
  maxStalenessSeconds: 3600,
  maxFeedsPerChange: 100,
  requiredApprovals: 2,
  highImpactApprovals: 3,
  maxReviewers: 7,
  reviewWindowSeconds: 48 * 60 * 60,
  timelockSeconds: 24 * 60 * 60,
  highImpactTimelockSeconds: 48 * 60 * 60,
} as const;

// ── Deterministic serialisation ──────────────────────────────────────────────

/**
 * JSON with object keys sorted recursively and `undefined` dropped, so the
 * same logical value always produces the same bytes. Every digest in the
 * governance surface is taken over this encoding.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function digestOf(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Digest of feed guard rails only — stable across version metadata changes. */
export function feedsDigest(policy: CatalogPolicy): string {
  return digestOf(
    [...policy.feeds]
      .sort((a, b) => a.asset.localeCompare(b.asset))
      .map((feed) => ({ ...feed, sources: [...feed.sources].sort() })),
  );
}

// ── Normalisation ────────────────────────────────────────────────────────────

function normalizeAsset(asset: string): string {
  return asset.trim().toUpperCase();
}

export function normalizeFeed(feed: FeedPolicy): FeedPolicy {
  return {
    asset: normalizeAsset(feed.asset),
    sources: [...new Set(feed.sources.map((source) => source.trim().toLowerCase()))].sort(),
    minSources: feed.minSources,
    maxDeviationBps: feed.maxDeviationBps,
    stalenessSeconds: feed.stalenessSeconds,
    enabled: feed.enabled,
  };
}

export function normalizeChange(change: CatalogPolicyChange): CatalogPolicyChange {
  return {
    baseVersion: change.baseVersion,
    kind: change.kind,
    upserts: change.upserts.map(normalizeFeed).sort((a, b) => a.asset.localeCompare(b.asset)),
    removals: [...new Set(change.removals.map(normalizeAsset))].sort(),
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

export type GuardrailSeverity = 'error' | 'warning';

export interface GuardrailFinding {
  code: string;
  severity: GuardrailSeverity;
  message: string;
  asset?: string;
}

export interface CatalogDiff {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: string[];
}

export interface CatalogValidation {
  findings: GuardrailFinding[];
  errors: GuardrailFinding[];
  warnings: GuardrailFinding[];
  diff: CatalogDiff;
  highImpact: boolean;
  /** Feed guard rails after the change (before de-duplication by version). */
  nextFeeds: FeedPolicy[];
}

export function diffPolicies(before: FeedPolicy[], after: FeedPolicy[]): CatalogDiff {
  const beforeMap = new Map(before.map((feed) => [feed.asset, canonicalJson(feed)]));
  const afterMap = new Map(after.map((feed) => [feed.asset, canonicalJson(feed)]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  for (const [asset, json] of afterMap) {
    const previous = beforeMap.get(asset);
    if (previous === undefined) added.push(asset);
    else if (previous === json) unchanged.push(asset);
    else modified.push(asset);
  }
  for (const asset of beforeMap.keys()) {
    if (!afterMap.has(asset)) removed.push(asset);
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    unchanged: unchanged.sort(),
  };
}

/** Materialise the feed set a change would produce. Does not assign a version. */
export function projectFeeds(current: CatalogPolicy, change: CatalogPolicyChange): FeedPolicy[] {
  const feeds = new Map(current.feeds.map((feed) => [feed.asset, feed]));
  for (const asset of change.removals) feeds.delete(asset);
  for (const feed of change.upserts) feeds.set(feed.asset, feed);
  return [...feeds.values()].sort((a, b) => a.asset.localeCompare(b.asset));
}

export function validateCatalogChange(
  current: CatalogPolicy,
  rawChange: CatalogPolicyChange,
): CatalogValidation {
  const change = normalizeChange(rawChange);
  const findings: GuardrailFinding[] = [];
  const error = (code: string, message: string, asset?: string): void => {
    findings.push({ code, severity: 'error', message, asset });
  };
  const warn = (code: string, message: string, asset?: string): void => {
    findings.push({ code, severity: 'warning', message, asset });
  };

  if (change.baseVersion !== current.version) {
    error(
      'STALE_BASE_VERSION',
      `Change was authored against policy version ${change.baseVersion}, but version ${current.version} is live`,
    );
  }

  if (change.upserts.length + change.removals.length === 0) {
    error('EMPTY_CHANGE', 'Change contains no upserts and no removals');
  }
  if (change.upserts.length + change.removals.length > CATALOG_GUARDRAILS.maxFeedsPerChange) {
    error(
      'TOO_MANY_CHANGES',
      `Change touches more than ${CATALOG_GUARDRAILS.maxFeedsPerChange} feeds`,
    );
  }

  const seen = new Set<string>();
  for (const feed of change.upserts) {
    if (seen.has(feed.asset)) {
      error('DUPLICATE_ASSET', `Asset ${feed.asset} appears more than once`, feed.asset);
    }
    seen.add(feed.asset);
    if (change.removals.includes(feed.asset)) {
      error(
        'CONFLICTING_CHANGE',
        `Asset ${feed.asset} is both upserted and removed`,
        feed.asset,
      );
    }
    validateFeed(feed, findings);
  }

  const currentAssets = new Set(current.feeds.map((feed) => feed.asset));
  for (const asset of change.removals) {
    if (!currentAssets.has(asset)) {
      error('UNKNOWN_FEED', `Cannot remove ${asset}: it is not part of the live policy`, asset);
    }
  }

  const nextFeeds = projectFeeds(current, change);
  if (nextFeeds.length === 0) {
    error('EMPTY_CATALOG', 'A governed change cannot leave the catalog with no feeds');
  }
  if (!nextFeeds.some((feed) => feed.enabled)) {
    error('NO_ENABLED_FEEDS', 'A governed change cannot disable every feed');
  }

  const diff = diffPolicies(current.feeds, nextFeeds);
  if (diff.added.length + diff.removed.length + diff.modified.length === 0) {
    error('NO_OP_CHANGE', 'Change produces the live policy byte-for-byte');
  }

  const beforeByAsset = new Map(current.feeds.map((feed) => [feed.asset, feed]));
  let highImpact = change.kind === 'rollback' || diff.added.length > 0 || diff.removed.length > 0;

  for (const asset of diff.modified) {
    const before = beforeByAsset.get(asset);
    const after = nextFeeds.find((feed) => feed.asset === asset);
    if (!before || !after) continue;

    if (before.enabled && !after.enabled) {
      highImpact = true;
      warn('FEED_DISABLED', `Feed ${asset} is being disabled`, asset);
    }
    if (!before.enabled && after.enabled) {
      highImpact = true;
      warn('FEED_ENABLED', `Feed ${asset} is being re-enabled`, asset);
    }
    if (after.maxDeviationBps > before.maxDeviationBps) {
      highImpact = true;
      warn(
        'DEVIATION_LOOSENED',
        `Feed ${asset} deviation threshold rises from ${before.maxDeviationBps} to ${after.maxDeviationBps} bps`,
        asset,
      );
    }
    if (after.stalenessSeconds > before.stalenessSeconds) {
      highImpact = true;
      warn(
        'STALENESS_LOOSENED',
        `Feed ${asset} staleness bound rises from ${before.stalenessSeconds}s to ${after.stalenessSeconds}s`,
        asset,
      );
    }
    if (after.minSources < before.minSources) {
      highImpact = true;
      warn(
        'MIN_SOURCES_REDUCED',
        `Feed ${asset} minimum sources drops from ${before.minSources} to ${after.minSources}`,
        asset,
      );
    }
    const droppedSources = before.sources.filter((source) => !after.sources.includes(source));
    if (droppedSources.length > 0 && after.enabled) {
      highImpact = true;
      warn(
        'SOURCE_SET_REDUCED',
        `Feed ${asset} no longer aggregates ${droppedSources.join(', ')}`,
        asset,
      );
    }
  }

  return {
    findings,
    errors: findings.filter((finding) => finding.severity === 'error'),
    warnings: findings.filter((finding) => finding.severity === 'warning'),
    diff,
    highImpact,
    nextFeeds,
  };
}

function validateFeed(feed: FeedPolicy, findings: GuardrailFinding[]): void {
  const push = (code: string, severity: GuardrailSeverity, message: string): void => {
    findings.push({ code, severity, message, asset: feed.asset });
  };

  if (!/^[A-Z0-9]{2,12}$/.test(feed.asset)) {
    push('INVALID_ASSET', 'error', `Asset "${feed.asset}" is not a valid upper-case ticker`);
  }
  for (const source of feed.sources) {
    if (!(CATALOG_SOURCES as readonly string[]).includes(source)) {
      push('UNKNOWN_SOURCE', 'error', `Source "${source}" is not a registered oracle provider`);
    }
  }
  if (feed.sources.length < CATALOG_GUARDRAILS.minSourceCount) {
    push(
      'INSUFFICIENT_SOURCES',
      'error',
      `Feed declares ${feed.sources.length} source(s); the floor is ${CATALOG_GUARDRAILS.minSourceCount}`,
    );
  }
  if (
    !Number.isInteger(feed.minSources) ||
    feed.minSources < CATALOG_GUARDRAILS.minSourceCount
  ) {
    push(
      'MIN_SOURCES_BELOW_FLOOR',
      'error',
      `minSources must be an integer >= ${CATALOG_GUARDRAILS.minSourceCount}`,
    );
  }
  if (feed.minSources > feed.sources.length) {
    push('MIN_SOURCES_EXCEEDS_SOURCES', 'error', 'minSources exceeds the declared source count');
  }
  if (
    !Number.isInteger(feed.maxDeviationBps) ||
    feed.maxDeviationBps < CATALOG_GUARDRAILS.minDeviationBps ||
    feed.maxDeviationBps > CATALOG_GUARDRAILS.maxDeviationBps
  ) {
    push(
      'DEVIATION_OUT_OF_BOUNDS',
      'error',
      `maxDeviationBps must be an integer between ${CATALOG_GUARDRAILS.minDeviationBps} and ${CATALOG_GUARDRAILS.maxDeviationBps}`,
    );
  }
  if (
    !Number.isInteger(feed.stalenessSeconds) ||
    feed.stalenessSeconds < CATALOG_GUARDRAILS.minStalenessSeconds ||
    feed.stalenessSeconds > CATALOG_GUARDRAILS.maxStalenessSeconds
  ) {
    push(
      'STALENESS_OUT_OF_BOUNDS',
      'error',
      `stalenessSeconds must be an integer between ${CATALOG_GUARDRAILS.minStalenessSeconds} and ${CATALOG_GUARDRAILS.maxStalenessSeconds}`,
    );
  }
}

/** Build the version that activates a validated change. */
export function applyCatalogChange(
  current: CatalogPolicy,
  change: CatalogPolicyChange,
  meta: { activatedAt: string; proposalId: number },
): CatalogPolicy {
  return {
    version: current.version + 1,
    activatedAt: meta.activatedAt,
    proposalId: meta.proposalId,
    feeds: projectFeeds(current, change),
  };
}

// ── On-chain action plan ─────────────────────────────────────────────────────

export type OnChainActionName =
  | 'SetTrustedAsset'
  | 'AddSource'
  | 'RemoveSource'
  | 'SetDeviationThreshold';

export interface OnChainAction {
  action: OnChainActionName;
  params: Record<string, string | number | boolean>;
}

export interface OnChainPlan {
  actions: OnChainAction[];
  /** Parameters the Soroban contract does not store; enforced by the services. */
  offChainParameters: string[];
  missingSourceAddresses: string[];
  digest: string;
}

function enabledSources(feeds: FeedPolicy[]): Set<string> {
  return new Set(feeds.filter((feed) => feed.enabled).flatMap((feed) => feed.sources));
}

/**
 * Translate a catalog change into the proposal actions the Soroban contract
 * already understands. Parameters without an on-chain representation are
 * listed in `offChainParameters` instead of being silently dropped.
 */
export function buildOnChainPlan(
  current: CatalogPolicy,
  nextFeeds: FeedPolicy[],
  sourceAddresses: Record<string, string>,
): OnChainPlan {
  const actions: OnChainAction[] = [];
  const before = new Map(current.feeds.map((feed) => [feed.asset, feed]));
  const after = new Map(nextFeeds.map((feed) => [feed.asset, feed]));

  for (const [asset, feed] of after) {
    const previous = before.get(asset);
    if (!previous) {
      if (feed.enabled) actions.push({ action: 'SetTrustedAsset', params: { asset, trusted: true } });
    } else if (previous.enabled !== feed.enabled) {
      actions.push({ action: 'SetTrustedAsset', params: { asset, trusted: feed.enabled } });
    }
  }
  for (const [asset, feed] of before) {
    if (!after.has(asset) && feed.enabled) {
      actions.push({ action: 'SetTrustedAsset', params: { asset, trusted: false } });
    }
  }

  const sourcesBefore = enabledSources(current.feeds);
  const sourcesAfter = enabledSources(nextFeeds);
  const missingSourceAddresses: string[] = [];

  for (const source of [...sourcesAfter].sort()) {
    if (sourcesBefore.has(source)) continue;
    const address = sourceAddresses[source];
    if (!address) missingSourceAddresses.push(source);
    else actions.push({ action: 'AddSource', params: { source: address, name: source } });
  }
  for (const source of [...sourcesBefore].sort()) {
    if (sourcesAfter.has(source)) continue;
    const address = sourceAddresses[source];
    if (!address) missingSourceAddresses.push(source);
    else actions.push({ action: 'RemoveSource', params: { source: address } });
  }

  const nextEnabled = nextFeeds.filter((feed) => feed.enabled);
  const thresholds = new Set(nextEnabled.map((feed) => feed.maxDeviationBps));
  if (thresholds.size === 1 && nextEnabled.length > 0) {
    const [thresholdBps] = [...thresholds];
    const previousThresholds = new Set(
      current.feeds.filter((feed) => feed.enabled).map((feed) => feed.maxDeviationBps),
    );
    if (previousThresholds.size !== 1 || !previousThresholds.has(thresholdBps)) {
      actions.push({ action: 'SetDeviationThreshold', params: { thresholdBps } });
    }
  }

  const offChainParameters: string[] = [];
  if (thresholds.size > 1) offChainParameters.push('maxDeviationBps (per feed)');
  if (parametersChanged(current.feeds, nextFeeds, 'minSources')) offChainParameters.push('minSources');
  if (parametersChanged(current.feeds, nextFeeds, 'stalenessSeconds')) {
    offChainParameters.push('stalenessSeconds');
  }

  const sortedActions = actions.sort((a, b) =>
    `${a.action}:${canonicalJson(a.params)}`.localeCompare(`${b.action}:${canonicalJson(b.params)}`),
  );

  return {
    actions: sortedActions,
    offChainParameters: offChainParameters.sort(),
    missingSourceAddresses: missingSourceAddresses.sort(),
    digest: digestOf({ actions: sortedActions, offChainParameters: offChainParameters.sort() }),
  };
}

function parametersChanged(
  before: FeedPolicy[],
  after: FeedPolicy[],
  key: 'minSources' | 'stalenessSeconds',
): boolean {
  const beforeByAsset = new Map(before.map((feed) => [feed.asset, feed[key]]));
  return after.some((feed) => beforeByAsset.get(feed.asset) !== feed[key]);
}

// ── Proposal lifecycle ───────────────────────────────────────────────────────

export type CatalogProposalStatus =
  | 'InReview'
  | 'Approved'
  | 'Rejected'
  | 'Activated'
  | 'Expired';

export interface CatalogReviewRecord {
  reviewer: string;
  decision: 'approve' | 'reject';
  at: string;
}

/** Minimal shape the impact simulator returns; kept here to avoid a cycle. */
export interface CatalogImpactSummary {
  generatedAt: string;
  deterministicHash: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  approvalBlocked: boolean;
  warnings: string[];
}

export interface OnChainExecution {
  actionIndex: number;
  onChainProposalId: number;
}

export interface CatalogProposal {
  id: number;
  proposer: string;
  description: string;
  change: CatalogPolicyChange;
  status: CatalogProposalStatus;
  createdAt: string;
  reviewDeadlineAt: string;
  timelockEndsAt?: string;
  activatedAt?: string;
  activatedVersion?: number;
  activatedBy?: string;
  reviews: CatalogReviewRecord[];
  findings: GuardrailFinding[];
  highImpact: boolean;
  requiredApprovals: number;
  sourceAddresses: Record<string, string>;
  onChainPlan: OnChainPlan;
  onChainExecutions?: OnChainExecution[];
  impact?: CatalogImpactSummary;
}

export class CatalogGovernanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CatalogGovernanceError';
  }
}

export interface CatalogGovernanceDeps {
  now?: () => Date;
  /** Returns the reasons `actor` must be recused from a change (empty = none). */
  isRecused?: (actor: string, request: RecusalRequest) => string[];
  /** True when an emergency override currently restricts `asset`. */
  isFrozen?: (asset: string) => boolean;
}

const GENESIS_FEEDS: FeedPolicy[] = [
  {
    asset: 'XLM',
    sources: ['chainlink', 'redstone', 'band'],
    minSources: 2,
    maxDeviationBps: 150,
    stalenessSeconds: 60,
    enabled: true,
  },
  {
    asset: 'USDC',
    sources: ['chainlink', 'reflector', 'band'],
    minSources: 2,
    maxDeviationBps: 50,
    stalenessSeconds: 60,
    enabled: true,
  },
];

export class CatalogGovernance {
  private readonly now: () => Date;
  private readonly isRecused: (actor: string, request: RecusalRequest) => string[];
  private readonly isFrozen: (asset: string) => boolean;
  private versions: CatalogPolicy[];
  private proposals = new Map<number, CatalogProposal>();
  private proposalCount = 0;

  constructor(deps: CatalogGovernanceDeps = {}, genesisFeeds: FeedPolicy[] = GENESIS_FEEDS) {
    this.now = deps.now ?? (() => new Date());
    this.isRecused = deps.isRecused ?? (() => []);
    this.isFrozen = deps.isFrozen ?? (() => false);
    this.versions = [
      {
        version: 1,
        activatedAt: new Date(0).toISOString(),
        proposalId: null,
        feeds: genesisFeeds
          .map(normalizeFeed)
          .sort((a, b) => a.asset.localeCompare(b.asset)),
      },
    ];
  }

  currentPolicy(): CatalogPolicy {
    return clonePolicy(this.versions[this.versions.length - 1]);
  }

  policyVersion(version: number): CatalogPolicy {
    const policy = this.versions.find((candidate) => candidate.version === version);
    if (!policy) {
      throw new CatalogGovernanceError('POLICY_VERSION_NOT_FOUND', `No catalog policy version ${version}`, 404);
    }
    return clonePolicy(policy);
  }

  policyHistory(): Array<{ version: number; activatedAt: string; proposalId: number | null; digest: string }> {
    return this.versions
      .map((policy) => ({
        version: policy.version,
        activatedAt: policy.activatedAt,
        proposalId: policy.proposalId,
        digest: feedsDigest(policy),
      }))
      .sort((a, b) => b.version - a.version);
  }

  createProposal(input: {
    proposer: string;
    description: string;
    change: CatalogPolicyChange;
    sourceAddresses?: Record<string, string>;
  }): CatalogProposal {
    const proposer = requireActor(input.proposer);
    if (!input.description || input.description.trim().length === 0) {
      throw new CatalogGovernanceError('DESCRIPTION_REQUIRED', 'A proposal description is required', 400);
    }
    if (input.description.length > 2000) {
      throw new CatalogGovernanceError('DESCRIPTION_TOO_LONG', 'Description exceeds 2000 characters', 400);
    }

    const current = this.currentPolicy();
    const change = normalizeChange(input.change);
    const validation = validateCatalogChange(current, change);
    if (validation.errors.length > 0) {
      throw new CatalogGovernanceError(
        'CATALOG_POLICY_INVALID',
        'The proposed change violates catalog policy guard rails',
        422,
        { findings: validation.errors },
      );
    }

    const sourceAddresses = input.sourceAddresses ?? {};
    const plan = buildOnChainPlan(current, validation.nextFeeds, sourceAddresses);
    if (plan.missingSourceAddresses.length > 0) {
      throw new CatalogGovernanceError(
        'MISSING_SOURCE_ADDRESS',
        `No on-chain address is registered for source(s): ${plan.missingSourceAddresses.join(', ')}`,
        422,
        { missingSourceAddresses: plan.missingSourceAddresses },
      );
    }

    const now = this.now();
    const id = ++this.proposalCount;
    const proposal: CatalogProposal = {
      id,
      proposer,
      description: input.description.trim(),
      change,
      status: 'InReview',
      createdAt: now.toISOString(),
      reviewDeadlineAt: new Date(
        now.getTime() + CATALOG_GUARDRAILS.reviewWindowSeconds * 1000,
      ).toISOString(),
      reviews: [],
      findings: validation.findings,
      highImpact: validation.highImpact,
      requiredApprovals: validation.highImpact
        ? CATALOG_GUARDRAILS.highImpactApprovals
        : CATALOG_GUARDRAILS.requiredApprovals,
      sourceAddresses: { ...sourceAddresses },
      onChainPlan: plan,
    };

    this.proposals.set(id, proposal);
    return cloneProposal(proposal);
  }

  getProposal(id: number): CatalogProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new CatalogGovernanceError('PROPOSAL_NOT_FOUND', `Catalog proposal ${id} not found`, 404);
    }
    return cloneProposal(proposal);
  }

  listProposals(filter: { status?: CatalogProposalStatus } = {}): CatalogProposal[] {
    return [...this.proposals.values()]
      .filter((proposal) => !filter.status || proposal.status === filter.status)
      .sort((a, b) => b.id - a.id)
      .map(cloneProposal);
  }

  /** Attach the impact analysis reviewers are expected to read before approving. */
  attachImpact(id: number, impact: CatalogImpactSummary): CatalogProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new CatalogGovernanceError('PROPOSAL_NOT_FOUND', `Catalog proposal ${id} not found`, 404);
    }
    if (proposal.status !== 'InReview') {
      throw new CatalogGovernanceError(
        'IMPACT_NOT_ACCEPTED',
        `Impact analysis can only be attached while a proposal is InReview (current: ${proposal.status})`,
        409,
      );
    }
    proposal.impact = { ...impact };
    return cloneProposal(proposal);
  }

  recordReview(
    id: number,
    reviewer: string,
    decision: 'approve' | 'reject',
    options: { attested: boolean },
  ): CatalogProposal {
    const actor = requireActor(reviewer);
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new CatalogGovernanceError('PROPOSAL_NOT_FOUND', `Catalog proposal ${id} not found`, 404);
    }
    if (proposal.status !== 'InReview') {
      throw new CatalogGovernanceError(
        'PROPOSAL_NOT_IN_REVIEW',
        `Proposal ${id} is ${proposal.status}; only InReview proposals accept reviews`,
        409,
      );
    }

    const now = this.now();
    if (now.getTime() > Date.parse(proposal.reviewDeadlineAt)) {
      proposal.status = 'Expired';
      throw new CatalogGovernanceError(
        'REVIEW_WINDOW_EXPIRED',
        `Proposal ${id} passed its review deadline at ${proposal.reviewDeadlineAt}`,
        409,
      );
    }
    if (actor === proposal.proposer) {
      throw new CatalogGovernanceError(
        'SELF_REVIEW_FORBIDDEN',
        'A proposal author cannot review their own catalog change',
        403,
      );
    }
    if (!options.attested) {
      throw new CatalogGovernanceError(
        'ATTESTATION_REQUIRED',
        'Reviewers must attest to the conflict-of-interest register before reviewing',
        409,
      );
    }
    if (proposal.reviews.some((review) => review.reviewer === actor)) {
      throw new CatalogGovernanceError('ALREADY_REVIEWED', `${actor} already reviewed proposal ${id}`, 409);
    }
    if (proposal.reviews.length >= CATALOG_GUARDRAILS.maxReviewers) {
      throw new CatalogGovernanceError('REVIEW_LIMIT_REACHED', 'Proposal has reached its review limit', 409);
    }

    const recusalReasons = this.isRecused(actor, this.recusalRequest(proposal));
    if (recusalReasons.length > 0) {
      throw new CatalogGovernanceError(
        'CONFLICT_OF_INTEREST',
        `${actor} is recused from this proposal: ${recusalReasons.join('; ')}`,
        409,
        { reasons: recusalReasons },
      );
    }

    const approvals = proposal.reviews.filter((review) => review.decision === 'approve').length;
    const completesApproval =
      decision === 'approve' && approvals + 1 >= proposal.requiredApprovals;

    // Checked before recording the review: a gated approval must leave no
    // partial state behind, so the same reviewer can retry once the analysis
    // has been recorded.
    if (completesApproval) {
      if (!proposal.impact) {
        throw new CatalogGovernanceError(
          'IMPACT_ANALYSIS_REQUIRED',
          'Approval cannot complete before an impact analysis has been recorded',
          409,
        );
      }
      if (proposal.impact.approvalBlocked) {
        throw new CatalogGovernanceError(
          'IMPACT_ANALYSIS_BLOCKED',
          `Impact analysis blocks approval (risk: ${proposal.impact.risk})`,
          409,
        );
      }
    }

    proposal.reviews.push({ reviewer: actor, decision, at: now.toISOString() });

    if (decision === 'reject') {
      proposal.status = 'Rejected';
      return cloneProposal(proposal);
    }

    if (completesApproval) {
      proposal.status = 'Approved';
      const timelock = proposal.highImpact
        ? CATALOG_GUARDRAILS.highImpactTimelockSeconds
        : CATALOG_GUARDRAILS.timelockSeconds;
      proposal.timelockEndsAt = new Date(now.getTime() + timelock * 1000).toISOString();
    }

    return cloneProposal(proposal);
  }

  /**
   * Activate an approved proposal as a new immutable policy version.
   *
   * `executions` maps every on-chain plan action to the multisig proposal that
   * carried it; the route layer verifies each one against the recorded multisig
   * proposals before calling this method.
   */
  activate(id: number, actor: string, executions: OnChainExecution[]): CatalogProposal {
    const caller = requireActor(actor);
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new CatalogGovernanceError('PROPOSAL_NOT_FOUND', `Catalog proposal ${id} not found`, 404);
    }
    if (proposal.status !== 'Approved') {
      throw new CatalogGovernanceError(
        'PROPOSAL_NOT_APPROVED',
        `Proposal ${id} is ${proposal.status}; only Approved proposals can be activated`,
        409,
      );
    }

    const now = this.now();
    if (!proposal.timelockEndsAt || now.getTime() < Date.parse(proposal.timelockEndsAt)) {
      throw new CatalogGovernanceError(
        'TIMELOCK_ACTIVE',
        `Proposal ${id} cannot be activated before ${proposal.timelockEndsAt ?? 'its timelock'}`,
        409,
      );
    }

    const current = this.currentPolicy();
    const validation = validateCatalogChange(current, proposal.change);
    if (validation.errors.length > 0) {
      throw new CatalogGovernanceError(
        'POLICY_DRIFT',
        'The live policy changed after this proposal was authored; the change is no longer safe to apply',
        409,
        { findings: validation.errors },
      );
    }

    const recalculatedPlan = buildOnChainPlan(current, validation.nextFeeds, proposal.sourceAddresses);
    if (recalculatedPlan.digest !== proposal.onChainPlan.digest) {
      throw new CatalogGovernanceError(
        'PLAN_DRIFTED',
        'The on-chain action plan no longer matches the reviewed plan',
        409,
      );
    }

    for (const asset of [...validation.diff.added, ...validation.diff.removed, ...validation.diff.modified]) {
      if (this.isFrozen(asset)) {
        throw new CatalogGovernanceError(
          'EMERGENCY_OVERRIDE_ACTIVE',
          `Feed ${asset} is under an active emergency override; close it before activating a policy change`,
          409,
          { asset },
        );
      }
    }

    this.assertExecutionsComplete(proposal, executions);

    const next = applyCatalogChange(current, proposal.change, {
      activatedAt: now.toISOString(),
      proposalId: proposal.id,
    });
    this.versions.push(next);

    proposal.status = 'Activated';
    proposal.activatedAt = next.activatedAt;
    proposal.activatedVersion = next.version;
    proposal.activatedBy = caller;
    proposal.onChainExecutions = executions.map((execution) => ({ ...execution }));

    return cloneProposal(proposal);
  }

  /** Rollback goes through the same review + timelock path as any change. */
  createRollbackProposal(input: {
    proposer: string;
    targetVersion: number;
    description?: string;
    sourceAddresses?: Record<string, string>;
  }): CatalogProposal {
    const current = this.currentPolicy();
    if (input.targetVersion === current.version) {
      throw new CatalogGovernanceError(
        'ROLLBACK_TARGET_IS_LIVE',
        `Policy version ${input.targetVersion} is already live`,
        409,
      );
    }
    const target = this.policyVersion(input.targetVersion);

    const targetAssets = new Set(target.feeds.map((feed) => feed.asset));
    const change: CatalogPolicyChange = {
      baseVersion: current.version,
      kind: 'rollback',
      upserts: target.feeds,
      removals: current.feeds
        .map((feed) => feed.asset)
        .filter((asset) => !targetAssets.has(asset)),
    };

    return this.createProposal({
      proposer: input.proposer,
      description:
        input.description?.trim() ||
        `Rollback catalog policy from v${current.version} to v${input.targetVersion}`,
      change,
      sourceAddresses: input.sourceAddresses,
    });
  }

  /** Mark proposals whose review window lapsed without a decision. */
  sweepExpired(): number {
    const now = this.now().getTime();
    let expired = 0;
    for (const proposal of this.proposals.values()) {
      if (proposal.status === 'InReview' && now > Date.parse(proposal.reviewDeadlineAt)) {
        proposal.status = 'Expired';
        expired += 1;
      }
    }
    return expired;
  }

  private recusalRequest(proposal: CatalogProposal): RecusalRequest {
    const assets = new Set<string>();
    const sources = new Set<string>();
    for (const feed of proposal.change.upserts) {
      assets.add(feed.asset);
      for (const source of feed.sources) sources.add(source);
    }
    for (const asset of proposal.change.removals) assets.add(asset);
    return { assets: [...assets].sort(), sources: [...sources].sort() };
  }

  private assertExecutionsComplete(proposal: CatalogProposal, executions: OnChainExecution[]): void {
    const expected = proposal.onChainPlan.actions.length;
    const seen = new Set<number>();
    for (const execution of executions) {
      if (
        !Number.isInteger(execution.actionIndex) ||
        execution.actionIndex < 0 ||
        execution.actionIndex >= expected
      ) {
        throw new CatalogGovernanceError(
          'ON_CHAIN_EXECUTION_INVALID',
          `actionIndex ${execution.actionIndex} is outside the plan (${expected} action(s))`,
          422,
        );
      }
      if (seen.has(execution.actionIndex)) {
        throw new CatalogGovernanceError(
          'ON_CHAIN_EXECUTION_INVALID',
          `actionIndex ${execution.actionIndex} is supplied more than once`,
          422,
        );
      }
      if (!Number.isInteger(execution.onChainProposalId) || execution.onChainProposalId <= 0) {
        throw new CatalogGovernanceError(
          'ON_CHAIN_EXECUTION_INVALID',
          'onChainProposalId must be a positive integer',
          422,
        );
      }
      seen.add(execution.actionIndex);
    }
    if (seen.size !== expected) {
      throw new CatalogGovernanceError(
        'ON_CHAIN_EXECUTION_INCOMPLETE',
        `Plan has ${expected} on-chain action(s); ${seen.size} executed`,
        409,
        { expected, supplied: seen.size },
      );
    }
  }
}

function requireActor(actor: string): string {
  if (!actor || typeof actor !== 'string' || actor.trim().length === 0) {
    throw new CatalogGovernanceError('ACTOR_REQUIRED', 'An authenticated actor is required', 400);
  }
  return actor.trim();
}

function clonePolicy(policy: CatalogPolicy): CatalogPolicy {
  return {
    version: policy.version,
    activatedAt: policy.activatedAt,
    proposalId: policy.proposalId,
    feeds: policy.feeds.map((feed) => ({ ...feed, sources: [...feed.sources] })),
  };
}

function cloneProposal(proposal: CatalogProposal): CatalogProposal {
  return {
    ...proposal,
    change: {
      ...proposal.change,
      upserts: proposal.change.upserts.map((feed) => ({ ...feed, sources: [...feed.sources] })),
      removals: [...proposal.change.removals],
    },
    reviews: proposal.reviews.map((review) => ({ ...review })),
    findings: proposal.findings.map((finding) => ({ ...finding })),
    sourceAddresses: { ...proposal.sourceAddresses },
    onChainPlan: {
      ...proposal.onChainPlan,
      actions: proposal.onChainPlan.actions.map((action) => ({ ...action, params: { ...action.params } })),
      offChainParameters: [...proposal.onChainPlan.offChainParameters],
      missingSourceAddresses: [...proposal.onChainPlan.missingSourceAddresses],
    },
    onChainExecutions: proposal.onChainExecutions?.map((execution) => ({ ...execution })),
    impact: proposal.impact ? { ...proposal.impact, warnings: [...proposal.impact.warnings] } : undefined,
  };
}
