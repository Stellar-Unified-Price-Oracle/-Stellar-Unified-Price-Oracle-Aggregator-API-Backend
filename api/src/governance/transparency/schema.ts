import { z } from 'zod';

const isoDate = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be an ISO-8601 timestamp',
  });

const minorUnits = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer amount in minor units');

const assetSymbol = z
  .string()
  .regex(/^[A-Z0-9]{2,12}$/, 'must be a 2-12 character uppercase asset symbol');

const policyKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}$/, 'must be a lowercase snake_case policy key');

const publicUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), { message: 'must be an https URL' });

const addressLike = z.string().min(3).max(128);

// ── Delegation and quorum health (#777) ──────────────────────────────────────

export const GOVERNANCE_PROPOSAL_STATUSES = [
  'Active',
  'Queued',
  'Ready',
  'Executed',
  'Defeated',
  'Cancelled',
] as const;

export const proposalVoteRecordSchema = z.object({
  id: z.number().int().nonnegative(),
  status: z.enum(GOVERNANCE_PROPOSAL_STATUSES),
  votesFor: minorUnits,
  votesAgainst: minorUnits,
  abstainPower: minorUnits.optional(),
  abstainVoters: z.number().int().nonnegative().optional(),
  eligibleVotingPower: minorUnits,
  quorumRequired: minorUnits,
  voters: z.number().int().nonnegative(),
});

export const delegationRecordSchema = z.object({
  delegator: addressLike,
  delegate: addressLike,
  power: minorUnits,
});

export const governanceSnapshotSchema = z.object({
  asOf: isoDate,
  network: z.string().min(1),
  token: z.object({
    symbol: z.string().min(1).max(12),
    decimals: z.number().int().min(0).max(18),
  }),
  eligibleVoters: z.number().int().nonnegative(),
  totalVotingPower: minorUnits,
  delegations: z.array(delegationRecordSchema).default([]),
  proposals: z.array(proposalVoteRecordSchema).default([]),
});

export type GovernanceSnapshot = z.infer<typeof governanceSnapshotSchema>;
export type GovernanceProposalVoteRecord = z.infer<typeof proposalVoteRecordSchema>;

// ── Treasury transparency (#781) ─────────────────────────────────────────────

export const treasurySourceReferenceSchema = z.object({
  kind: z.enum(['ledger', 'transaction', 'invoice', 'signature', 'account']),
  ref: z.string().min(1),
  url: publicUrl.optional(),
});

export const treasuryEntrySchema = z.object({
  id: z.string().min(1),
  timestamp: isoDate,
  direction: z.enum(['inflow', 'outflow']),
  asset: assetSymbol,
  amount: minorUnits,
  category: z.string().min(1).max(64),
  policy: policyKey,
  source: treasurySourceReferenceSchema.optional(),
  counterparty: z.string().min(1).max(128).optional(),
  memo: z.string().max(280).optional(),
});

export const treasuryAssetPositionSchema = z.object({
  asset: assetSymbol,
  decimals: z.number().int().min(0).max(18),
  openingBalance: minorUnits,
  closingBalance: minorUnits,
  source: treasurySourceReferenceSchema.optional(),
});

export const treasuryPolicySchema = z.object({
  version: z.string().min(1),
  approvedAt: isoDate,
  approvedBy: z.string().min(1),
  reference: publicUrl,
  allocations: z
    .array(
      z.object({
        policy: policyKey,
        targetShareBps: z.number().int().min(0).max(10_000),
        description: z.string().max(280).optional(),
      }),
    )
    .min(1),
});

export const treasurySnapshotSchema = z.object({
  asOf: isoDate,
  network: z.string().min(1),
  treasuryAccount: addressLike,
  updateCadenceHours: z.number().positive().max(24 * 366),
  assets: z.array(treasuryAssetPositionSchema).min(1),
  policy: treasuryPolicySchema,
  entries: z.array(treasuryEntrySchema).default([]),
});

export type TreasurySnapshot = z.infer<typeof treasurySnapshotSchema>;
export type TreasuryEntry = z.infer<typeof treasuryEntrySchema>;
export type TreasuryAssetPosition = z.infer<typeof treasuryAssetPositionSchema>;

// ── Community release review windows (#779) ─────────────────────────────────

export const CHANGE_CLASSES = ['contract', 'feed', 'api', 'docs', 'infrastructure'] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

export const releaseChangeSchema = z.object({
  class: z.enum(CHANGE_CLASSES),
  description: z.string().min(1).max(280),
  breaking: z.boolean().optional(),
});

export const emergencyDeclarationSchema = z.object({
  declaredBy: z.string().min(1),
  declaredAt: isoDate,
  reason: z.string().min(1).max(500),
  retrospectiveAt: isoDate,
});

export const releaseReviewEntrySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  summary: z.string().min(1).max(280),
  owner: z.string().min(1),
  changes: z.array(releaseChangeSchema).min(1),
  announcedAt: isoDate,
  releaseAt: isoDate,
  feedbackChannels: z.array(publicUrl).default([]),
  emergency: emergencyDeclarationSchema.optional(),
  status: z.enum(['planned', 'released', 'withdrawn']).default('planned'),
});

export const releaseReviewSnapshotSchema = z.object({
  asOf: isoDate,
  releases: z.array(releaseReviewEntrySchema).default([]),
});

export type ReleaseReviewSnapshot = z.infer<typeof releaseReviewSnapshotSchema>;
export type ReleaseReviewEntry = z.infer<typeof releaseReviewEntrySchema>;
export type EmergencyDeclaration = z.infer<typeof emergencyDeclarationSchema>;
