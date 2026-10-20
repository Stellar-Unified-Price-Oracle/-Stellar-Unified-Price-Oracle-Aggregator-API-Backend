/**
 * Conflict-of-interest disclosure register (#776).
 *
 * Decision makers and feed reviewers declare the financial and provider
 * relationships that could bias a catalog decision. Declarations are scoped
 * (asset, provider, or protocol) and time-bounded: every declaration carries an
 * explicit expiry. An expired declaration is treated as *worse* than a current
 * one — it still recuses its author, because the register can no longer prove
 * the relationship ended, and it blocks reviews until it is re-declared.
 *
 * Reviewers must also attest to the register within `attestationValiditySeconds`
 * before approving or reviewing. The catalog and emergency registries call
 * `assertEligible` so a recused actor cannot approve a policy change or
 * countersign an emergency action.
 */

export type CoiRelationshipType =
  | 'financial'
  | 'employment'
  | 'provider-affiliation'
  | 'token-holding'
  | 'family'
  | 'other';

export type CoiScope = 'asset' | 'source' | 'protocol';

export type CoiDisclosureStatus = 'active' | 'withdrawn' | 'expired';

export interface CoiDisclosure {
  id: string;
  actor: string;
  relationship: CoiRelationshipType;
  counterparty: string;
  scope: CoiScope;
  details: string;
  disclosedAt: string;
  expiresAt: string;
  status: CoiDisclosureStatus;
  closedAt?: string;
}

export interface CoiAttestation {
  actor: string;
  attestedAt: string;
  expiresAt: string;
  statement?: string;
}

export interface RecusalRequest {
  assets: string[];
  sources: string[];
}

export interface CoiEligibility {
  eligible: boolean;
  code?: 'ATTESTATION_REQUIRED' | 'CONFLICT_OF_INTEREST';
  reasons: string[];
}

export const COI_LIMITS = {
  attestationValiditySeconds: 90 * 24 * 60 * 60,
  maxDisclosureSeconds: 365 * 24 * 60 * 60,
  maxDetailsLength: 2000,
  maxStatementLength: 500,
} as const;

const RELATIONSHIPS: readonly CoiRelationshipType[] = [
  'financial',
  'employment',
  'provider-affiliation',
  'token-holding',
  'family',
  'other',
];
const SCOPES: readonly CoiScope[] = ['asset', 'source', 'protocol'];

export class CoiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CoiError';
  }
}

export interface CoiRegisterDeps {
  now?: () => Date;
  attestationValiditySeconds?: number;
}

export class CoiRegister {
  private readonly now: () => Date;
  private readonly attestationValiditySeconds: number;
  private disclosures = new Map<string, CoiDisclosure>();
  private attestations = new Map<string, CoiAttestation>();
  private disclosureCount = 0;

  constructor(deps: CoiRegisterDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.attestationValiditySeconds =
      deps.attestationValiditySeconds ?? COI_LIMITS.attestationValiditySeconds;
  }

  declare(input: {
    actor: string;
    relationship: string;
    counterparty: string;
    scope: string;
    details?: string;
    expiresAt?: string;
    attested: boolean;
  }): CoiDisclosure {
    const now = this.now();
    const actor = requireText(input.actor, 'actor');
    if (!input.attested) {
      throw new CoiError(
        'ATTESTATION_REQUIRED',
        'A disclosure must be attested; set "attested": true after confirming the statement is accurate',
        409,
      );
    }
    if (!RELATIONSHIPS.includes(input.relationship as CoiRelationshipType)) {
      throw new CoiError(
        'INVALID_RELATIONSHIP',
        `relationship must be one of: ${RELATIONSHIPS.join(', ')}`,
      );
    }
    if (!SCOPES.includes(input.scope as CoiScope)) {
      throw new CoiError('INVALID_SCOPE', `scope must be one of: ${SCOPES.join(', ')}`);
    }
    const counterparty = requireText(input.counterparty, 'counterparty');
    const details = (input.details ?? '').trim();
    if (details.length > COI_LIMITS.maxDetailsLength) {
      throw new CoiError('DETAILS_TOO_LONG', `details exceeds ${COI_LIMITS.maxDetailsLength} characters`);
    }
    if (input.relationship === 'other' && details.length === 0) {
      throw new CoiError('DETAILS_REQUIRED', 'A disclosure of type "other" must describe the relationship');
    }

    const maxExpiry = now.getTime() + COI_LIMITS.maxDisclosureSeconds * 1000;
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(maxExpiry);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new CoiError('INVALID_EXPIRY', 'expiresAt must be an ISO-8601 timestamp');
    }
    if (expiresAt.getTime() <= now.getTime()) {
      throw new CoiError('EXPIRY_IN_PAST', 'expiresAt must be in the future');
    }
    if (expiresAt.getTime() > maxExpiry) {
      throw new CoiError(
        'EXPIRY_TOO_FAR',
        `A disclosure cannot stay valid for more than ${COI_LIMITS.maxDisclosureSeconds / 86400} days`,
      );
    }

    const duplicate = [...this.disclosures.values()].find(
      (disclosure) =>
        disclosure.status === 'active' &&
        disclosure.actor === actor &&
        disclosure.relationship === input.relationship &&
        disclosure.scope === input.scope &&
        normalize(counterparty) === normalize(disclosure.counterparty),
    );
    if (duplicate) {
      throw new CoiError(
        'DUPLICATE_DISCLOSURE',
        `An active disclosure for this relationship already exists (${duplicate.id}); withdraw it before re-declaring`,
        409,
        { disclosureId: duplicate.id },
      );
    }

    const id = `coi_${++this.disclosureCount}`;
    const disclosure: CoiDisclosure = {
      id,
      actor,
      relationship: input.relationship as CoiRelationshipType,
      counterparty,
      scope: input.scope as CoiScope,
      details,
      disclosedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
    };
    this.disclosures.set(id, disclosure);
    return { ...disclosure };
  }

  withdraw(id: string, actor: string): CoiDisclosure {
    const disclosure = this.requireDisclosure(id);
    const caller = requireText(actor, 'actor');
    if (disclosure.actor !== caller) {
      throw new CoiError(
        'NOT_DISCLOSURE_OWNER',
        'Only the discloser can withdraw their own declaration',
        403,
      );
    }
    if (disclosure.status !== 'active') {
      throw new CoiError(
        'DISCLOSURE_NOT_ACTIVE',
        `Disclosure ${id} is ${disclosure.status} and cannot be withdrawn`,
        409,
      );
    }
    disclosure.status = 'withdrawn';
    disclosure.closedAt = this.now().toISOString();
    return { ...disclosure };
  }

  list(filter: { actor?: string; status?: CoiDisclosureStatus } = {}): CoiDisclosure[] {
    this.sweep();
    return [...this.disclosures.values()]
      .filter((disclosure) => !filter.actor || disclosure.actor === filter.actor)
      .filter((disclosure) => !filter.status || disclosure.status === filter.status)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((disclosure) => ({ ...disclosure }));
  }

  /** Marks declarations past their expiry so the register never overstates coverage. */
  sweep(): number {
    const now = this.now().getTime();
    let expired = 0;
    for (const disclosure of this.disclosures.values()) {
      if (disclosure.status === 'active' && now >= Date.parse(disclosure.expiresAt)) {
        disclosure.status = 'expired';
        expired += 1;
      }
    }
    return expired;
  }

  attest(actor: string, statement?: string): CoiAttestation {
    const identity = requireText(actor, 'actor');
    if (statement && statement.length > COI_LIMITS.maxStatementLength) {
      throw new CoiError(
        'STATEMENT_TOO_LONG',
        `statement exceeds ${COI_LIMITS.maxStatementLength} characters`,
      );
    }
    const now = this.now();
    const attestation: CoiAttestation = {
      actor: identity,
      attestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.attestationValiditySeconds * 1000).toISOString(),
      statement: statement?.trim() || undefined,
    };
    this.attestations.set(identity, attestation);
    return { ...attestation };
  }

  attestationStatus(actor: string): {
    valid: boolean;
    attestedAt?: string;
    expiresAt?: string;
  } {
    const attestation = this.attestations.get(actor);
    if (!attestation) return { valid: false };
    if (this.now().getTime() >= Date.parse(attestation.expiresAt)) {
      return { valid: false, attestedAt: attestation.attestedAt, expiresAt: attestation.expiresAt };
    }
    return { valid: true, attestedAt: attestation.attestedAt, expiresAt: attestation.expiresAt };
  }

  /**
   * Reasons `actor` must be recused from a decision covering `request`.
   * Both active and expired declarations recuse; withdrawn ones do not.
   */
  recusalReasons(actor: string, request: RecusalRequest): string[] {
    this.sweep();
    const assets = new Set(request.assets.map(normalize));
    const sources = new Set(request.sources.map(normalize));
    const reasons: string[] = [];

    for (const disclosure of this.disclosures.values()) {
      if (disclosure.actor !== actor || disclosure.status === 'withdrawn') continue;

      let matches = false;
      if (disclosure.scope === 'protocol') matches = true;
      else if (disclosure.scope === 'asset') matches = assets.has(normalize(disclosure.counterparty));
      else if (disclosure.scope === 'source') matches = sources.has(normalize(disclosure.counterparty));
      if (!matches) continue;

      const state =
        disclosure.status === 'expired'
          ? `declaration ${disclosure.id} expired on ${disclosure.expiresAt}`
          : `active ${disclosure.relationship} relationship with ${disclosure.counterparty} (${disclosure.id})`;
      reasons.push(`conflict of interest: ${state}`);
    }

    return reasons.sort();
  }

  checkEligibility(actor: string, request: RecusalRequest): CoiEligibility {
    const attestation = this.attestationStatus(actor);
    if (!attestation.valid) {
      return {
        eligible: false,
        code: 'ATTESTATION_REQUIRED',
        reasons: attestation.attestedAt
          ? [`attestation expired on ${attestation.expiresAt}; re-attest to the register`]
          : ['no conflict-of-interest attestation on file'],
      };
    }
    const reasons = this.recusalReasons(actor, request);
    if (reasons.length > 0) {
      return { eligible: false, code: 'CONFLICT_OF_INTEREST', reasons };
    }
    return { eligible: true, reasons: [] };
  }

  assertEligible(actor: string, request: RecusalRequest): void {
    const eligibility = this.checkEligibility(actor, request);
    if (eligibility.eligible) return;
    throw new CoiError(
      eligibility.code ?? 'CONFLICT_OF_INTEREST',
      `${actor} cannot participate: ${eligibility.reasons.join('; ')}`,
      409,
      { reasons: eligibility.reasons },
    );
  }

  private requireDisclosure(id: string): CoiDisclosure {
    const disclosure = this.disclosures.get(id);
    if (!disclosure) {
      throw new CoiError('DISCLOSURE_NOT_FOUND', `Disclosure ${id} not found`, 404);
    }
    return disclosure;
  }
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoiError('INVALID_REQUEST', `"${field}" is required`, 400);
  }
  return value.trim();
}
