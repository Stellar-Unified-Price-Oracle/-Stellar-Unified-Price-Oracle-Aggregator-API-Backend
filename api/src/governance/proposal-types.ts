/**
 * TypeScript type definitions mirroring the Soroban contract types for
 * governance (token-based voting) and multi-sig (signer-based) proposals.
 *
 * These types are used by the proposal-service and proposal-routes modules
 * to provide a typed interface to the governance and multi-sig contracts.
 */

// ── Common types ──────────────────────────────────────────────────────────────

export type ProposalAction =
  | { variant: 'AddSource'; source: string; name: string }
  | { variant: 'RemoveSource'; source: string }
  | { variant: 'SetTrustedAsset'; asset: string; trusted: number }
  | { variant: 'TransferAdmin'; newAdmin: string }
  | { variant: 'SetDeviationThreshold'; thresholdBps: number }
  | { variant: 'ResetReputation'; source: string }
  | { variant: 'AddSigner'; signer: string }
  | { variant: 'RemoveSigner'; signer: string }
  | { variant: 'SetThreshold'; threshold: number }
  | { variant: 'SetAdmin'; newAdmin: string }
  | { variant: 'AddOracleSource'; source: string; name: string }
  | { variant: 'RemoveOracleSource'; source: string }
  | { variant: 'UpdateGovernanceConfig'; config: GovernanceConfig };

// ── Multi-sig (signer-based) ─────────────────────────────────────────────────

export interface MultiSigConfig {
  signers: string[];
  threshold: number;
}

export interface MultiSigProposal {
  id: number;
  action: ProposalAction;
  approvals: string[];
  executed: number; // 0 = pending, 1 = executed
  createdAt: string;
  proposer: string;
}

// ── Governance (token-based voting) ──────────────────────────────────────────

export type ProposalStatus =
  | 'Active'
  | 'Queued'
  | 'Ready'
  | 'Executed'
  | 'Defeated'
  | 'Cancelled';

export interface GovernanceConfig {
  token: string;
  votingPeriod: number;
  timelockDelay: number;
  quorum: number;
  proposalThreshold: number;
  guardian: string;
}

export interface GovernanceProposal {
  id: number;
  proposer: string;
  action: ProposalAction;
  description: string;
  votesFor: number;
  votesAgainst: number;
  votingStart: string;
  votingEnd: string;
  executionTime: string;
  status: ProposalStatus;
}

// ── API request/response types ───────────────────────────────────────────────

export interface CreateMultiSigProposalRequest {
  action: ProposalAction;
}

export interface ApproveProposalRequest {
  proposalId: number;
}

export interface ExecuteProposalRequest {
  proposalId: number;
}

export interface CreateGovernanceProposalRequest {
  action: ProposalAction;
  description: string;
}

export interface CastVoteRequest {
  proposalId: number;
  support: boolean;
}

export interface CancelProposalRequest {
  proposalId: number;
}

export interface ListProposalsQuery {
  status?: ProposalStatus;
  proposer?: string;
  page?: number;
  limit?: number;
}

export interface ProposalListResponse<T> {
  proposals: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Quick helper: resolve an action variant string for display.
 * Returns e.g. "Add Source (GABC...)" or "Set Deviation Threshold: 500 bps".
 */
export function formatAction(action: ProposalAction): string {
  switch (action.variant) {
    case 'AddSource':
      return `Add Source (${action.source.substring(0, 8)}..., "${action.name}")`;
    case 'RemoveSource':
      return `Remove Source (${action.source.substring(0, 8)}...)`;
    case 'SetTrustedAsset':
      return `Set Trusted Asset (${action.asset}, trusted=${action.trusted ? 'yes' : 'no'})`;
    case 'TransferAdmin':
      return `Transfer Admin → ${action.newAdmin.substring(0, 8)}...`;
    case 'SetDeviationThreshold':
      return `Set Deviation Threshold: ${action.thresholdBps} bps`;
    case 'ResetReputation':
      return `Reset Reputation (${action.source.substring(0, 8)}...)`;
    case 'AddSigner':
      return `Add Signer (${action.signer.substring(0, 8)}...)`;
    case 'RemoveSigner':
      return `Remove Signer (${action.signer.substring(0, 8)}...)`;
    case 'SetThreshold':
      return `Set Threshold: ${action.threshold}`;
    case 'SetAdmin':
      return `Set Admin → ${action.newAdmin.substring(0, 8)}...`;
    case 'AddOracleSource':
      return `Add Oracle Source (${action.source.substring(0, 8)}..., "${action.name}")`;
    case 'RemoveOracleSource':
      return `Remove Oracle Source (${action.source.substring(0, 8)}...)`;
    case 'UpdateGovernanceConfig':
      return 'Update Governance Config';
  }
}

/**
 * Derive a short, human-readable badge label for a proposal status.
 */
export function statusLabel(status: ProposalStatus): string {
  const labels: Record<ProposalStatus, string> = {
    Active: 'Voting',
    Queued: 'Queued',
    Ready: 'Ready',
    Executed: 'Executed',
    Defeated: 'Defeated',
    Cancelled: 'Cancelled',
  };
  return labels[status] || status;
}

/**
 * Map a proposal status to a CSS class / colour hint for UI rendering.
 */
export function statusColor(status: ProposalStatus): string {
  const colors: Record<ProposalStatus, string> = {
    Active: 'blue',
    Queued: 'yellow',
    Ready: 'green',
    Executed: 'green',
    Defeated: 'red',
    Cancelled: 'gray',
  };
  return colors[status] || 'gray';
}
