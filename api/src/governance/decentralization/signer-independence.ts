import {
  GovernanceReportingError,
  type SharedControlFinding,
  type SignerAssessment,
  type SignerFinding,
  type SignerIndependencePolicy,
  type SignerIndependenceReport,
  type SignerProfile,
} from './types';

const DAY_SECONDS = 86_400;

export const DEFAULT_SIGNER_INDEPENDENCE_POLICY: SignerIndependencePolicy = {
  minIndependentSigners: 3,
  rotationIntervalDays: 180,
  minAvailabilityPct: 99,
  maxSignersPerCustodyProvider: 2,
  maxSignersPerOrganization: 2,
  disallowedCustody: ['software'],
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function validatePolicy(policy: SignerIndependencePolicy): void {
  if (!Number.isInteger(policy.minIndependentSigners) || policy.minIndependentSigners < 1) {
    throw new GovernanceReportingError(
      'INVALID_POLICY',
      'minIndependentSigners must be a positive integer',
    );
  }
  if (!Number.isFinite(policy.rotationIntervalDays) || policy.rotationIntervalDays <= 0) {
    throw new GovernanceReportingError('INVALID_POLICY', 'rotationIntervalDays must be positive');
  }
  if (
    !Number.isFinite(policy.minAvailabilityPct) ||
    policy.minAvailabilityPct < 0 ||
    policy.minAvailabilityPct > 100
  ) {
    throw new GovernanceReportingError(
      'INVALID_POLICY',
      'minAvailabilityPct must be between 0 and 100',
    );
  }
  if (policy.maxSignersPerCustodyProvider < 1 || policy.maxSignersPerOrganization < 1) {
    throw new GovernanceReportingError(
      'INVALID_POLICY',
      'per-provider and per-organization caps must be at least 1',
    );
  }
}

function validateProfile(profile: SignerProfile, now: number): void {
  if (!profile.address.trim() || !profile.organization.trim() || !profile.custodyProvider.trim()) {
    throw new GovernanceReportingError(
      'INVALID_SIGNER',
      `Signer ${profile.address || '<missing address>'} must declare an address, organization and custody provider`,
    );
  }
  if (
    !Number.isFinite(profile.availabilityPct) ||
    profile.availabilityPct < 0 ||
    profile.availabilityPct > 100
  ) {
    throw new GovernanceReportingError(
      'INVALID_SIGNER',
      `Signer ${profile.address} has availabilityPct outside 0..100`,
    );
  }
  if (!Number.isFinite(profile.addedAt) || !Number.isFinite(profile.lastRotatedAt)) {
    throw new GovernanceReportingError(
      'INVALID_SIGNER',
      `Signer ${profile.address} has a non-numeric rotation timestamp`,
    );
  }
  if (profile.lastRotatedAt > now + DAY_SECONDS) {
    throw new GovernanceReportingError(
      'INVALID_SIGNER',
      `Signer ${profile.address} declares a rotation in the future; refusing to score stale data`,
    );
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Maximum number of pairwise-independent signers is a maximum bipartite
 * matching between organizations and custody providers: each selected signer
 * consumes one distinct organization and one distinct provider, so every
 * selected signer is independent from every other by construction.
 */
function computeMaxIndependentQuorum(signers: SignerProfile[]): number {
  const organizations = new Map<string, number>();
  const providers = new Map<string, number>();
  const edges: number[][] = [];

  for (const signer of signers) {
    const organization = normalize(signer.organization);
    const provider = normalize(signer.custodyProvider);

    if (!organizations.has(organization)) {
      organizations.set(organization, organizations.size);
      edges.push([]);
    }
    if (!providers.has(provider)) {
      providers.set(provider, providers.size);
    }
    edges[organizations.get(organization)!].push(providers.get(provider)!);
  }

  const matchedOrganization: number[] = new Array(providers.size).fill(-1);
  let matching = 0;

  const assign = (organization: number, seen: boolean[]): boolean => {
    for (const provider of edges[organization]) {
      if (seen[provider]) continue;
      seen[provider] = true;
      if (
        matchedOrganization[provider] === -1 ||
        assign(matchedOrganization[provider], seen)
      ) {
        matchedOrganization[provider] = organization;
        return true;
      }
    }
    return false;
  };

  for (let organization = 0; organization < edges.length; organization++) {
    const seen = new Array(providers.size).fill(false);
    if (assign(organization, seen)) matching++;
  }

  return matching;
}

function undisclosedSharedControl(signers: SignerProfile[]): SharedControlFinding[] {
  const findings: SharedControlFinding[] = [];

  for (let i = 0; i < signers.length; i++) {
    for (let j = i + 1; j < signers.length; j++) {
      const left = signers[i];
      const right = signers[j];
      if (normalize(left.organization) !== normalize(right.organization)) continue;

      const leftDisclosesRight = left.conflicts.some(
        (conflict) =>
          normalize(conflict.party) === normalize(right.address) ||
          normalize(conflict.party) === normalize(right.organization),
      );
      const rightDisclosesLeft = right.conflicts.some(
        (conflict) =>
          normalize(conflict.party) === normalize(left.address) ||
          normalize(conflict.party) === normalize(left.organization),
      );

      if (!leftDisclosesRight && !rightDisclosesLeft) {
        findings.push({
          signers: [left.address, right.address],
          organization: left.organization,
        });
      }
    }
  }

  return findings;
}

export function evaluateSignerIndependence(
  profiles: SignerProfile[],
  policy: SignerIndependencePolicy = DEFAULT_SIGNER_INDEPENDENCE_POLICY,
  now: number = Math.floor(Date.now() / 1000),
): SignerIndependenceReport {
  if (profiles.length === 0) {
    throw new GovernanceReportingError(
      'EMPTY_SIGNER_ROSTER',
      'Cannot measure signer independence without a signer roster',
    );
  }

  validatePolicy(policy);
  for (const profile of profiles) validateProfile(profile, now);

  const findings: SignerFinding[] = [];
  const seenAddresses = new Set<string>();
  for (const profile of profiles) {
    const address = normalize(profile.address);
    if (seenAddresses.has(address)) {
      findings.push({
        code: 'DUPLICATE_SIGNER_ADDRESS',
        severity: 'critical',
        message: `Signer address ${profile.address} appears more than once in the roster`,
        signers: [profile.address],
      });
    }
    seenAddresses.add(address);
  }

  const assessments: SignerAssessment[] = profiles.map((profile) => {
    const violations: string[] = [];
    const daysSinceRotation = Math.floor((now - profile.lastRotatedAt) / DAY_SECONDS);

    if (policy.disallowedCustody.includes(profile.custody)) {
      violations.push('CUSTODY_NOT_ALLOWED');
    }
    if (daysSinceRotation > policy.rotationIntervalDays) {
      violations.push('ROTATION_OVERDUE');
    }
    if (profile.availabilityPct < policy.minAvailabilityPct) {
      violations.push('AVAILABILITY_BELOW_POLICY');
    }
    if (profile.conflicts.some((conflict) => conflict.mitigation.trim().length === 0)) {
      violations.push('CONFLICT_MITIGATION_MISSING');
    }

    return {
      address: profile.address,
      organization: profile.organization,
      custody: profile.custody,
      custodyProvider: profile.custodyProvider,
      region: profile.region,
      independent: violations.length === 0,
      daysSinceRotation,
      availabilityPct: profile.availabilityPct,
      violations,
    };
  });

  const independentProfiles = profiles.filter((_profile, index) => assessments[index].independent);
  const maxIndependentSet = computeMaxIndependentQuorum(independentProfiles);
  const quorumReachable = maxIndependentSet >= policy.minIndependentSigners;

  if (!quorumReachable) {
    findings.push({
      code: 'INDEPENDENT_QUORUM_UNREACHABLE',
      severity: 'critical',
      message:
        `Only ${maxIndependentSet} pairwise-independent signers can approve at once, ` +
        `but ${policy.minIndependentSigners} are required`,
      signers: independentProfiles.map((profile) => profile.address),
    });
  }

  const sharedControl = undisclosedSharedControl(profiles);
  for (const finding of sharedControl) {
    findings.push({
      code: 'UNDISCLOSED_SHARED_CONTROL',
      severity: 'critical',
      message:
        `Signers ${finding.signers[0]} and ${finding.signers[1]} share organization ` +
        `"${finding.organization}" without a declared conflict`,
      signers: [...finding.signers],
    });
  }

  const byProvider: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byOrganization: Record<string, number> = {};
  for (const profile of profiles) {
    byProvider[profile.custodyProvider] = (byProvider[profile.custodyProvider] ?? 0) + 1;
    byType[profile.custody] = (byType[profile.custody] ?? 0) + 1;
    byOrganization[profile.organization] = (byOrganization[profile.organization] ?? 0) + 1;
  }

  for (const [provider, count] of Object.entries(byProvider)) {
    if (count > policy.maxSignersPerCustodyProvider) {
      findings.push({
        code: 'CUSTODY_PROVIDER_CONCENTRATION',
        severity: 'high',
        message:
          `Custody provider "${provider}" controls ${count} signers ` +
          `(policy allows ${policy.maxSignersPerCustodyProvider})`,
        signers: profiles
          .filter((profile) => profile.custodyProvider === provider)
          .map((profile) => profile.address),
      });
    }
  }

  for (const [organization, count] of Object.entries(byOrganization)) {
    if (count > policy.maxSignersPerOrganization) {
      findings.push({
        code: 'ORGANIZATION_CONCENTRATION',
        severity: 'high',
        message:
          `Organization "${organization}" controls ${count} signers ` +
          `(policy allows ${policy.maxSignersPerOrganization})`,
        signers: profiles
          .filter((profile) => profile.organization === organization)
          .map((profile) => profile.address),
      });
    }
  }

  const overdue = assessments
    .filter((assessment) => assessment.violations.includes('ROTATION_OVERDUE'))
    .map((assessment) => assessment.address);
  const belowPolicy = assessments
    .filter((assessment) => assessment.violations.includes('AVAILABILITY_BELOW_POLICY'))
    .map((assessment) => assessment.address);
  const declaredConflicts = profiles.flatMap((profile) => profile.conflicts);
  const criticalFindings = findings.filter((finding) => finding.severity === 'critical');

  return {
    generatedAt: now,
    policy: { ...policy, disallowedCustody: [...policy.disallowedCustody] },
    signerCount: profiles.length,
    independentSignerCount: independentProfiles.length,
    quorumRequired: policy.minIndependentSigners,
    maxIndependentQuorum: maxIndependentSet,
    quorumReachable,
    custodyDiversity: {
      distinctTypes: Object.keys(byType).length,
      distinctProviders: Object.keys(byProvider).length,
      byType,
      byProvider,
    },
    rotation: {
      compliant: assessments.filter((a) => !a.violations.includes('ROTATION_OVERDUE')).length,
      overdue,
    },
    availability: {
      belowPolicy,
      medianPct: median(profiles.map((profile) => profile.availabilityPct)),
    },
    conflictDisclosure: {
      declared: declaredConflicts.length,
      unmitigated: declaredConflicts.filter((conflict) => !conflict.mitigation.trim()).length,
      undisclosedSharedControl: sharedControl,
    },
    signers: assessments,
    findings,
    verdict: criticalFindings.length === 0 && quorumReachable ? 'pass' : 'fail',
  };
}
