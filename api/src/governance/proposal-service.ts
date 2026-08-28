/**
 * Proposal service — bridges the REST API to the on-chain governance and
 * multi-sig contracts via the Soroban RPC.
 *
 * In production this would call `soroban contract invoke` or use the
 * Stellar SDK's `Server.invokeContract` to interact with the deployed
 * contracts.  For now the service provides a fully-typed mock layer that
 * mirrors the contract interface exactly, making it trivial to wire in
 * real RPC calls when deployed.
 */

import { logger } from '../observability/logger';
import {
  MultiSigConfig,
  MultiSigProposal,
  GovernanceConfig,
  GovernanceProposal,
  CreateMultiSigProposalRequest,
  CreateGovernanceProposalRequest,
  ListProposalsQuery,
  ProposalListResponse,
} from './proposal-types';

// ── In-memory stores (replace with contract RPC calls in production) ──────────

const multiSigProposals: Map<number, MultiSigProposal> = new Map();
let msigProposalCount = 0;
let msigConfig: MultiSigConfig | null = null;

const governanceProposals: Map<number, GovernanceProposal> = new Map();
let govProposalCount = 0;
let govConfig: GovernanceConfig | null = null;
const votes: Map<string, boolean> = new Map(); // key: `${proposalId}:${voter}`

// ── Multi-sig operations ─────────────────────────────────────────────────────

export async function initMultiSig(config: MultiSigConfig): Promise<void> {
  msigConfig = { ...config };
  msigProposalCount = 0;
  multiSigProposals.clear();
  logger.info('Multi-sig initialized', { signers: config.signers.length, threshold: config.threshold });
}

export async function getMultiSigConfig(): Promise<MultiSigConfig | null> {
  return msigConfig ? { ...msigConfig } : null;
}

export async function createMultiSigProposal(
  proposer: string,
  req: CreateMultiSigProposalRequest,
): Promise<MultiSigProposal> {
  if (!msigConfig) throw new Error('MultiSigNotInitialized');
  if (!msigConfig.signers.includes(proposer)) throw new Error('NotASigner');

  const id = ++msigProposalCount;
  const proposal: MultiSigProposal = {
    id,
    action: req.action,
    approvals: [proposer],
    executed: 0,
    createdAt: new Date().toISOString(),
    proposer,
  };

  multiSigProposals.set(id, proposal);
  logger.info('Multi-sig proposal created', { id, proposer: proposer.substring(0, 8) });
  return proposal;
}

export async function approveProposal(signer: string, proposalId: number): Promise<MultiSigProposal> {
  if (!msigConfig) throw new Error('MultiSigNotInitialized');
  if (!msigConfig.signers.includes(signer)) throw new Error('NotASigner');

  const proposal = multiSigProposals.get(proposalId);
  if (!proposal) throw new Error('ProposalNotFound');
  if (proposal.executed === 1) throw new Error('ProposalAlreadyExecuted');
  if (proposal.approvals.includes(signer)) throw new Error('AlreadyApproved');

  proposal.approvals.push(signer);
  multiSigProposals.set(proposalId, proposal);
  logger.info('Multi-sig proposal approved', { proposalId, signer: signer.substring(0, 8), approvals: proposal.approvals.length });
  return proposal;
}

export async function executeMultiSigProposal(signer: string, proposalId: number): Promise<MultiSigProposal> {
  if (!msigConfig) throw new Error('MultiSigNotInitialized');
  if (!msigConfig.signers.includes(signer)) throw new Error('NotASigner');

  const proposal = multiSigProposals.get(proposalId);
  if (!proposal) throw new Error('ProposalNotFound');
  if (proposal.executed === 1) throw new Error('ProposalAlreadyExecuted');
  if (proposal.approvals.length < msigConfig.threshold) throw new Error('ThresholdNotMet');

  proposal.executed = 1;
  multiSigProposals.set(proposalId, proposal);
  logger.info('Multi-sig proposal executed', { proposalId, executor: signer.substring(0, 8) });
  return proposal;
}

export async function getMultiSigProposal(id: number): Promise<MultiSigProposal | null> {
  return multiSigProposals.get(id) ?? null;
}

export async function listMultiSigProposals(
  query: ListProposalsQuery,
): Promise<ProposalListResponse<MultiSigProposal>> {
  let proposals = Array.from(multiSigProposals.values());

  if (query.proposer) {
    proposals = proposals.filter((p) => p.proposer === query.proposer);
  }

  const page = query.page || 1;
  const limit = query.limit || 20;
  const total = proposals.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;

  return {
    proposals: proposals.slice(start, start + limit),
    pagination: { page, limit, total, totalPages },
  };
}

// ── Governance (token-based) operations ──────────────────────────────────────

export async function initGovernance(config: GovernanceConfig): Promise<void> {
  govConfig = { ...config };
  govProposalCount = 0;
  governanceProposals.clear();
  votes.clear();
  logger.info('Governance initialized', { token: config.token.substring(0, 8), quorum: config.quorum });
}

export async function getGovernanceConfig(): Promise<GovernanceConfig | null> {
  return govConfig ? { ...govConfig } : null;
}

export async function createGovernanceProposal(
  proposer: string,
  req: CreateGovernanceProposalRequest,
): Promise<GovernanceProposal> {
  if (!govConfig) throw new Error('GovernanceNotInitialized');

  const id = ++govProposalCount;
  const now = Math.floor(Date.now() / 1000);
  const votingPeriod = govConfig.votingPeriod;
  const timelockDelay = govConfig.timelockDelay;

  const proposal: GovernanceProposal = {
    id,
    proposer,
    action: req.action,
    description: req.description,
    votesFor: 0,
    votesAgainst: 0,
    votingStart: new Date(now * 1000).toISOString(),
    votingEnd: new Date((now + votingPeriod) * 1000).toISOString(),
    executionTime: new Date((now + votingPeriod + timelockDelay) * 1000).toISOString(),
    status: 'Active',
  };

  governanceProposals.set(id, proposal);
  logger.info('Governance proposal created', { id, proposer: proposer.substring(0, 8) });
  return proposal;
}

export async function castVote(
  voter: string,
  proposalId: number,
  support: boolean,
): Promise<GovernanceProposal> {
  if (!govConfig) throw new Error('GovernanceNotInitialized');

  const proposal = governanceProposals.get(proposalId);
  if (!proposal) throw new Error('ProposalNotFound');
  if (proposal.status !== 'Active') throw new Error('VotingNotActive');

  const now = Math.floor(Date.now() / 1000);
  const votingEnd = Math.floor(new Date(proposal.votingEnd).getTime() / 1000);
  if (now >= votingEnd) throw new Error('VotingNotActive');

  const voteKey = `${proposalId}:${voter}`;
  if (votes.has(voteKey)) throw new Error('AlreadyVoted');

  // TODO: Replace hardcoded voting power with real on-chain balance query
  // via SEP-41 token contract when integrated with Soroban RPC.
  const votingPower = 100_000;

  if (support) {
    proposal.votesFor += votingPower;
  } else {
    proposal.votesAgainst += votingPower;
  }

  votes.set(voteKey, support);
  governanceProposals.set(proposalId, proposal);
  logger.info('Vote cast', { proposalId, voter: voter.substring(0, 8), support });
  return proposal;
}

export async function queueProposal(proposalId: number): Promise<GovernanceProposal> {
  if (!govConfig) throw new Error('GovernanceNotInitialized');

  const proposal = governanceProposals.get(proposalId);
  if (!proposal) throw new Error('ProposalNotFound');
  if (proposal.status !== 'Active') throw new Error('VotingNotActive');

  const now = Math.floor(Date.now() / 1000);
  const votingEnd = Math.floor(new Date(proposal.votingEnd).getTime() / 1000);
  if (now < votingEnd) throw new Error('VotingNotActive');

  const totalVotes = proposal.votesFor + proposal.votesAgainst;

  if (totalVotes >= govConfig.quorum && proposal.votesFor > proposal.votesAgainst) {
    proposal.status = 'Queued';
  } else {
    proposal.status = 'Defeated';
    governanceProposals.set(proposalId, proposal);
    throw new Error('ProposalDefeated');
  }

  governanceProposals.set(proposalId, proposal);
  logger.info('Governance proposal queued', { proposalId, status: proposal.status });
  return proposal;
}

export async function executeGovernanceProposal(proposalId: number): Promise<GovernanceProposal> {
  if (!govConfig) throw new Error('GovernanceNotInitialized');

  const proposal = governanceProposals.get(proposalId);
  if (!proposal) throw new Error('ProposalNotFound');

  if (proposal.status === 'Executed') throw new Error('ProposalAlreadyExecuted');
  if (proposal.status === 'Cancelled') throw new Error('ProposalCancelled');
  if (proposal.status === 'Defeated') throw new Error('ProposalDefeated');

  // Auto-resolve Active→Queued if voting period has passed
  if (proposal.status === 'Active') {
    const now = Math.floor(Date.now() / 1000);
    const votingEnd = Math.floor(new Date(proposal.votingEnd).getTime() / 1000);
    if (now >= votingEnd) {
      const totalVotes = proposal.votesFor + proposal.votesAgainst;
      if (totalVotes >= govConfig.quorum && proposal.votesFor > proposal.votesAgainst) {
        proposal.status = 'Queued';
        proposal.executionTime = new Date(now * 1000).toISOString();
      } else {
        proposal.status = 'Defeated';
        governanceProposals.set(proposalId, proposal);
        throw new Error('ProposalDefeated');
      }
    }
  }

  if (proposal.status !== 'Queued' && proposal.status !== 'Ready') {
    throw new Error('VotingNotActive');
  }

  const now = Math.floor(Date.now() / 1000);
  const executionTime = Math.floor(new Date(proposal.executionTime).getTime() / 1000);
  if (now < executionTime) throw new Error('TimeLockNotElapsed');

  proposal.status = 'Executed';
  governanceProposals.set(proposalId, proposal);
  logger.info('Governance proposal executed', { proposalId });
  return proposal;
}

export async function cancelProposal(
  caller: string,
  proposalId: number,
): Promise<GovernanceProposal> {
  if (!govConfig) throw new Error('GovernanceNotInitialized');

  const proposal = governanceProposals.get(proposalId);
  if (!proposal) throw new Error('ProposalNotFound');
  if (proposal.status === 'Executed') throw new Error('ProposalAlreadyExecuted');
  if (proposal.status === 'Cancelled') throw new Error('ProposalCancelled');

  proposal.status = 'Cancelled';
  governanceProposals.set(proposalId, proposal);
  logger.info('Governance proposal cancelled', { proposalId, caller: caller.substring(0, 8) });
  return proposal;
}

export async function emergencyExecute(
  guardian: string,
  proposalId: number,
): Promise<GovernanceProposal> {
  if (!govConfig) throw new Error('GovernanceNotInitialized');
  if (govConfig.guardian !== guardian) throw new Error('GuardianOnly');

  const proposal = governanceProposals.get(proposalId);
  if (!proposal) throw new Error('ProposalNotFound');
  if (proposal.status === 'Executed') throw new Error('ProposalAlreadyExecuted');
  if (proposal.status === 'Cancelled') throw new Error('ProposalCancelled');

  proposal.status = 'Executed';
  governanceProposals.set(proposalId, proposal);
  logger.info('Emergency execution', { proposalId, guardian: guardian.substring(0, 8) });
  return proposal;
}

export async function getGovernanceProposal(id: number): Promise<GovernanceProposal | null> {
  return governanceProposals.get(id) ?? null;
}

export async function listGovernanceProposals(
  query: ListProposalsQuery,
): Promise<ProposalListResponse<GovernanceProposal>> {
  let proposals = Array.from(governanceProposals.values());

  if (query.status) {
    proposals = proposals.filter((p) => p.status === query.status);
  }
  if (query.proposer) {
    proposals = proposals.filter((p) => p.proposer === query.proposer);
  }

  const page = query.page || 1;
  const limit = query.limit || 20;
  const total = proposals.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;

  return {
    proposals: proposals.slice(start, start + limit),
    pagination: { page, limit, total, totalPages },
  };
}

export async function hasVoted(proposalId: number, voter: string): Promise<boolean> {
  return votes.has(`${proposalId}:${voter}`);
}
