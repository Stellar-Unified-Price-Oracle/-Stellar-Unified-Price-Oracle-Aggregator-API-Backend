/**
 * Emergency governance powers with time bounds, independent review, and
 * post-action disclosure (#778).
 *
 * Emergency powers are deliberately *restrictive only*: an action can pause a
 * feed, freeze a provider, or halt publishing. There is no emergency action
 * that can add a feed, loosen a guard rail, move funds, or change signers —
 * those stay on the ordinary proposal path, so "emergency" can never be used
 * to bypass review.
 *
 * Every action must carry an expiry (at most 72 hours). An independent reviewer
 * — not the author, attested to the conflict-of-interest register, and not
 * recused — countersigns within 24 hours. A renewal is only possible for a
 * reviewed action and resets the review requirement, so an emergency cannot be
 * extended indefinitely by one person. Closing an action (expiry, revocation,
 * or overturn) requires a published post-action disclosure.
 */

import type { RecusalRequest } from './coi-register';

export type EmergencyActionKind = 'pause-feed' | 'freeze-source' | 'halt-publishing';

export type EmergencyActionStatus =
  | 'Active'
  | 'Reviewed'
  | 'Expired'
  | 'Revoked'
  | 'ExpiredUnreviewed';

export interface EmergencyAction {
  id: number;
  kind: EmergencyActionKind;
  asset?: string;
  source?: string;
  reason: string;
  actor: string;
  createdAt: string;
  expiresAt: string;
  reviewDeadlineAt: string;
  status: EmergencyActionStatus;
  reviewer?: string;
  reviewedAt?: string;
  reviewDecision?: 'confirm' | 'overturn';
  reviewOverdue?: boolean;
  renewals: number;
  /** Catalog policy version in force when the override was opened. */
  policyVersionAtCreation: number;
  revokedBy?: string;
  revokedAt?: string;
  revocationReason?: string;
  disclosure: {
    required: boolean;
    publishedAt?: string;
    publishedBy?: string;
    summary?: string;
    overdue?: boolean;
  };
}

export const EMERGENCY_LIMITS = {
  maxDurationSeconds: 72 * 60 * 60,
  reviewWindowSeconds: 24 * 60 * 60,
  disclosureWindowSeconds: 24 * 60 * 60,
  maxRenewals: 2,
  maxReasonLength: 500,
  maxDisclosureLength: 2000,
} as const;

const RESTRICTIVE_KINDS: readonly EmergencyActionKind[] = [
  'pause-feed',
  'freeze-source',
  'halt-publishing',
];

/** Kinds an emergency power may never express. Kept for the guard test. */
const PROHIBITED_KINDS = [
  'add-feed',
  'remove-feed',
  'loosen-guardrail',
  'add-signer',
  'transfer-admin',
  'set-threshold',
] as const;

export class EmergencyActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'EmergencyActionError';
  }
}

export interface EmergencyActionDeps {
  now?: () => Date;
  isRecused?: (actor: string, request: RecusalRequest) => string[];
  currentPolicyVersion?: () => number;
}

export class EmergencyActionRegistry {
  private readonly now: () => Date;
  private readonly isRecused: (actor: string, request: RecusalRequest) => string[];
  private readonly currentPolicyVersion: () => number;
  private actions = new Map<number, EmergencyAction>();
  private actionCount = 0;

  constructor(deps: EmergencyActionDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.isRecused = deps.isRecused ?? (() => []);
    this.currentPolicyVersion = deps.currentPolicyVersion ?? (() => 1);
  }

  /** The full set of kinds an emergency power is allowed to express. */
  static allowedKinds(): readonly EmergencyActionKind[] {
    return RESTRICTIVE_KINDS;
  }

  /** Kinds that must never be accepted through the emergency path. */
  static prohibitedKinds(): readonly string[] {
    return PROHIBITED_KINDS;
  }

  open(input: {
    kind: string;
    reason: string;
    actor: string;
    asset?: string;
    source?: string;
    expiresAt?: string;
    durationSeconds?: number;
  }): EmergencyAction {
    const actor = requireText(input.actor, 'actor');
    if (!RESTRICTIVE_KINDS.includes(input.kind as EmergencyActionKind)) {
      throw new EmergencyActionError(
        'EMERGENCY_KIND_NOT_PERMITTED',
        `Emergency actions are restrictive only; "${input.kind}" must go through the governed proposal path`,
        422,
        { permitted: [...RESTRICTIVE_KINDS] },
      );
    }
    const kind = input.kind as EmergencyActionKind;
    const reason = requireText(input.reason, 'reason');
    if (reason.length > EMERGENCY_LIMITS.maxReasonLength) {
      throw new EmergencyActionError(
        'REASON_TOO_LONG',
        `reason exceeds ${EMERGENCY_LIMITS.maxReasonLength} characters`,
      );
    }

    const now = this.now();
    const expiresAt = this.resolveExpiry(now, input.expiresAt, input.durationSeconds);

    const asset = input.asset?.trim().toUpperCase();
    const source = input.source?.trim().toLowerCase();
    if (kind === 'pause-feed' && !asset) {
      throw new EmergencyActionError('SCOPE_REQUIRED', 'pause-feed requires an "asset"');
    }
    if (kind === 'freeze-source' && !source) {
      throw new EmergencyActionError('SCOPE_REQUIRED', 'freeze-source requires a "source"');
    }
    if (kind === 'halt-publishing' && (asset || source)) {
      throw new EmergencyActionError(
        'SCOPE_NOT_ALLOWED',
        'halt-publishing is protocol-wide and does not take an asset or source',
      );
    }

    this.sweep();
    const duplicate = [...this.actions.values()].find(
      (action) =>
        isOpen(action) &&
        action.kind === kind &&
        action.asset === asset &&
        action.source === source,
    );
    if (duplicate) {
      throw new EmergencyActionError(
        'DUPLICATE_EMERGENCY_ACTION',
        `An open ${kind} action already covers this scope (${duplicate.id})`,
        409,
        { actionId: duplicate.id },
      );
    }

    const reviewDeadline = Math.min(
      now.getTime() + EMERGENCY_LIMITS.reviewWindowSeconds * 1000,
      Date.parse(expiresAt),
    );

    const action: EmergencyAction = {
      id: ++this.actionCount,
      kind,
      asset,
      source,
      reason,
      actor,
      createdAt: now.toISOString(),
      expiresAt,
      reviewDeadlineAt: new Date(reviewDeadline).toISOString(),
      status: 'Active',
      renewals: 0,
      policyVersionAtCreation: this.currentPolicyVersion(),
      disclosure: { required: true },
    };
    this.actions.set(action.id, action);
    return cloneAction(action);
  }

  get(id: number): EmergencyAction {
    this.sweep();
    const action = this.actions.get(id);
    if (!action) {
      throw new EmergencyActionError('EMERGENCY_ACTION_NOT_FOUND', `Emergency action ${id} not found`, 404);
    }
    return cloneAction(action);
  }

  list(filter: { status?: EmergencyActionStatus } = {}): EmergencyAction[] {
    this.sweep();
    return [...this.actions.values()]
      .filter((action) => !filter.status || action.status === filter.status)
      .sort((a, b) => b.id - a.id)
      .map(cloneAction);
  }

  review(
    id: number,
    reviewer: string,
    options: { decision: 'confirm' | 'overturn'; attested: boolean },
  ): EmergencyAction {
    const actor = requireText(reviewer, 'reviewer');
    this.sweep();
    const action = this.requireAction(id);

    if (action.status === 'Reviewed') {
      throw new EmergencyActionError('ALREADY_REVIEWED', `Emergency action ${id} is already reviewed`, 409);
    }
    if (action.status !== 'Active') {
      throw new EmergencyActionError(
        'EMERGENCY_ACTION_CLOSED',
        `Emergency action ${id} is ${action.status} and cannot be reviewed`,
        409,
      );
    }

    const now = this.now();
    if (now.getTime() > Date.parse(action.reviewDeadlineAt)) {
      action.reviewOverdue = true;
      throw new EmergencyActionError(
        'REVIEW_DEADLINE_PASSED',
        `Independent review was due by ${action.reviewDeadlineAt}; the action stays flagged as unreviewed`,
        409,
      );
    }
    if (actor === action.actor) {
      throw new EmergencyActionError(
        'INDEPENDENT_REVIEW_REQUIRED',
        'The author of an emergency action cannot review it',
        403,
      );
    }
    if (!options.attested) {
      throw new EmergencyActionError(
        'ATTESTATION_REQUIRED',
        'Reviewers must attest to the conflict-of-interest register before countersigning',
        409,
      );
    }

    const reasons = this.isRecused(actor, recusalRequestFor(action));
    if (reasons.length > 0) {
      throw new EmergencyActionError(
        'CONFLICT_OF_INTEREST',
        `${actor} is recused from this action: ${reasons.join('; ')}`,
        409,
        { reasons },
      );
    }

    action.reviewer = actor;
    action.reviewedAt = now.toISOString();
    action.reviewDecision = options.decision;
    action.reviewOverdue = false;
    if (options.decision === 'overturn') {
      action.status = 'Revoked';
      action.revokedBy = actor;
      action.revokedAt = now.toISOString();
      action.revocationReason = 'overturned on independent review';
    } else {
      action.status = 'Reviewed';
    }

    return cloneAction(action);
  }

  /**
   * Extend an action. Only a reviewed action can be renewed, the extension is
   * bounded, and the renewed window goes back to needing independent review.
   */
  renew(
    id: number,
    actor: string,
    input: { expiresAt?: string; durationSeconds?: number },
  ): EmergencyAction {
    requireText(actor, 'actor');
    this.sweep();
    const action = this.requireAction(id);

    if (action.status !== 'Reviewed') {
      throw new EmergencyActionError(
        'REVIEW_REQUIRED_BEFORE_RENEWAL',
        `Emergency action ${id} is ${action.status}; only a reviewed action can be renewed`,
        409,
      );
    }
    if (action.renewals >= EMERGENCY_LIMITS.maxRenewals) {
      throw new EmergencyActionError(
        'RENEWAL_LIMIT_REACHED',
        `Emergency action ${id} has already been renewed ${action.renewals} time(s)`,
        409,
      );
    }

    const now = this.now();
    const expiresAt = this.resolveExpiry(now, input.expiresAt, input.durationSeconds, action.expiresAt);
    const perWindowCap =
      Date.parse(action.expiresAt) + EMERGENCY_LIMITS.maxDurationSeconds * 1000;
    if (Date.parse(expiresAt) > perWindowCap) {
      throw new EmergencyActionError(
        'RENEWAL_TOO_LONG',
        `A renewal can extend an action by at most ${EMERGENCY_LIMITS.maxDurationSeconds / 3600} hours`,
        422,
      );
    }
    const totalCap =
      Date.parse(action.createdAt) +
      EMERGENCY_LIMITS.maxDurationSeconds * 1000 * (action.renewals + 2);
    if (Date.parse(expiresAt) > totalCap) {
      throw new EmergencyActionError(
        'RENEWAL_TOTAL_CAP_EXCEEDED',
        `Cumulative emergency duration cannot exceed ${EMERGENCY_LIMITS.maxDurationSeconds * (action.renewals + 2)} seconds from creation`,
        422,
      );
    }

    action.expiresAt = expiresAt;
    action.renewals += 1;
    action.status = 'Active';
    action.reviewer = undefined;
    action.reviewedAt = undefined;
    action.reviewDecision = undefined;
    action.reviewOverdue = false;
    action.reviewDeadlineAt = new Date(
      Math.min(now.getTime() + EMERGENCY_LIMITS.reviewWindowSeconds * 1000, Date.parse(expiresAt)),
    ).toISOString();

    return cloneAction(action);
  }

  revoke(id: number, actor: string, reason?: string): EmergencyAction {
    const caller = requireText(actor, 'actor');
    this.sweep();
    const action = this.requireAction(id);
    if (!isOpen(action)) {
      throw new EmergencyActionError(
        'EMERGENCY_ACTION_CLOSED',
        `Emergency action ${id} is ${action.status} and cannot be revoked`,
        409,
      );
    }
    if (reason && reason.length > EMERGENCY_LIMITS.maxReasonLength) {
      throw new EmergencyActionError('REASON_TOO_LONG', 'reason is too long');
    }

    action.status = 'Revoked';
    action.revokedBy = caller;
    action.revokedAt = this.now().toISOString();
    action.revocationReason = reason?.trim() || undefined;
    return cloneAction(action);
  }

  /**
   * Publish the public post-action account of what was done and why. Required
   * before an action can be considered closed in good standing.
   */
  publishDisclosure(
    id: number,
    input: { summary: string; actor: string },
  ): EmergencyAction {
    const caller = requireText(input.actor, 'actor');
    const summary = requireText(input.summary, 'summary');
    if (summary.length > EMERGENCY_LIMITS.maxDisclosureLength) {
      throw new EmergencyActionError(
        'DISCLOSURE_TOO_LONG',
        `summary exceeds ${EMERGENCY_LIMITS.maxDisclosureLength} characters`,
      );
    }
    this.sweep();
    const action = this.requireAction(id);
    if (isOpen(action)) {
      throw new EmergencyActionError(
        'DISCLOSURE_BEFORE_CLOSE',
        'Post-action disclosure is published after the action closes, not while it is still in force',
        409,
      );
    }
    if (action.disclosure.publishedAt) {
      throw new EmergencyActionError('DISCLOSURE_ALREADY_PUBLISHED', 'Disclosure already published', 409);
    }

    const now = this.now();
    action.disclosure = {
      required: true,
      summary,
      publishedAt: now.toISOString(),
      publishedBy: caller,
      overdue: now.getTime() > Date.parse(action.expiresAt) + EMERGENCY_LIMITS.disclosureWindowSeconds * 1000,
    };
    return cloneAction(action);
  }

  /** Applies expiry to every action and flags overdue disclosures/reviews. */
  sweep(): number {
    const now = this.now().getTime();
    let changed = 0;
    for (const action of this.actions.values()) {
      const expired = now >= Date.parse(action.expiresAt);
      if (isOpen(action) && expired) {
        action.status = action.status === 'Reviewed' ? 'Expired' : 'ExpiredUnreviewed';
        changed += 1;
      }
      if (!action.reviewedAt && !isOpen(action) && action.status === 'ExpiredUnreviewed') {
        action.reviewOverdue = true;
      }
      if (
        !action.disclosure.publishedAt &&
        now >= Date.parse(action.expiresAt) + EMERGENCY_LIMITS.disclosureWindowSeconds * 1000
      ) {
        action.disclosure = { ...action.disclosure, overdue: true };
      }
    }
    return changed;
  }

  /** Assets/sources/protocol that are currently restricted by an open action. */
  activeOverlays(): { assets: Set<string>; sources: Set<string>; halted: boolean } {
    this.sweep();
    const assets = new Set<string>();
    const sources = new Set<string>();
    let halted = false;
    for (const action of this.actions.values()) {
      if (!isOpen(action)) continue;
      if (action.kind === 'pause-feed' && action.asset) assets.add(action.asset);
      if (action.kind === 'freeze-source' && action.source) sources.add(action.source);
      if (action.kind === 'halt-publishing') halted = true;
    }
    return { assets, sources, halted };
  }

  isFrozen(asset: string): boolean {
    const overlays = this.activeOverlays();
    return overlays.halted || overlays.assets.has(asset.trim().toUpperCase());
  }

  isSourceFrozen(source: string): boolean {
    const overlays = this.activeOverlays();
    return overlays.halted || overlays.sources.has(source.trim().toLowerCase());
  }

  /** Actions past their review deadline without a countersignature. */
  overdueReviews(): EmergencyAction[] {
    this.sweep();
    const now = this.now().getTime();
    return [...this.actions.values()]
      .filter(
        (action) =>
          action.status === 'Active' && now > Date.parse(action.reviewDeadlineAt),
      )
      .sort((a, b) => a.id - b.id)
      .map(cloneAction);
  }

  /** Closed actions whose post-action disclosure is overdue. */
  overdueDisclosures(): EmergencyAction[] {
    this.sweep();
    return [...this.actions.values()]
      .filter((action) => !isOpen(action) && !action.disclosure.publishedAt && action.disclosure.overdue)
      .sort((a, b) => a.id - b.id)
      .map(cloneAction);
  }

  private resolveExpiry(
    now: Date,
    expiresAt?: string,
    durationSeconds?: number,
    floor?: string,
  ): string {
    const hasExpiry = typeof expiresAt === 'string' && expiresAt.trim().length > 0;
    if (!hasExpiry && durationSeconds === undefined) {
      throw new EmergencyActionError(
        'EXPIRY_REQUIRED',
        'Emergency actions must carry an explicit expiry (expiresAt or durationSeconds)',
        422,
      );
    }

    const resolved = hasExpiry
      ? new Date(expiresAt as string)
      : new Date(now.getTime() + Number(durationSeconds) * 1000);
    if (Number.isNaN(resolved.getTime())) {
      throw new EmergencyActionError('INVALID_EXPIRY', 'expiresAt must be an ISO-8601 timestamp');
    }

    const lowerBound = floor ? Date.parse(floor) : now.getTime();
    if (resolved.getTime() <= lowerBound) {
      throw new EmergencyActionError(
        'EXPIRY_NOT_EXTENDING',
        floor ? 'A renewal must extend the current expiry' : 'expiresAt must be in the future',
      );
    }
    const upperBound = now.getTime() + EMERGENCY_LIMITS.maxDurationSeconds * 1000;
    if (!floor && resolved.getTime() > upperBound) {
      throw new EmergencyActionError(
        'EXPIRY_TOO_FAR',
        `An emergency action cannot run longer than ${EMERGENCY_LIMITS.maxDurationSeconds / 3600} hours`,
        422,
      );
    }
    return resolved.toISOString();
  }

  private requireAction(id: number): EmergencyAction {
    const action = this.actions.get(id);
    if (!action) {
      throw new EmergencyActionError('EMERGENCY_ACTION_NOT_FOUND', `Emergency action ${id} not found`, 404);
    }
    return action;
  }
}

function isOpen(action: EmergencyAction): boolean {
  return action.status === 'Active' || action.status === 'Reviewed';
}

function recusalRequestFor(action: EmergencyAction): RecusalRequest {
  return {
    assets: action.asset ? [action.asset] : [],
    sources: action.source ? [action.source] : [],
  };
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmergencyActionError('INVALID_REQUEST', `"${field}" is required`, 400);
  }
  return value.trim();
}

function cloneAction(action: EmergencyAction): EmergencyAction {
  return { ...action, disclosure: { ...action.disclosure } };
}
