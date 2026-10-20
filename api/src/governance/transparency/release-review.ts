import type { ChangeClass, ReleaseReviewEntry, ReleaseReviewSnapshot } from './schema';

export const REVIEW_CLOSE_LEAD_HOURS = 24;
export const BREAKING_CHANGE_EXTRA_DAYS = 7;
export const EMERGENCY_MIN_NOTICE_HOURS = 24;
export const EMERGENCY_RETROSPECTIVE_WITHIN_HOURS = 48;

export interface ChangeClassRule {
  minNoticeDays: number;
  material: boolean;
  rationale: string;
}

export const CHANGE_CLASS_RULES: Record<ChangeClass, ChangeClassRule> = {
  contract: {
    minNoticeDays: 14,
    material: true,
    rationale: 'On-chain behaviour and storage changes cannot be patched quickly, so integrators need the longest window.',
  },
  feed: {
    minNoticeDays: 10,
    material: true,
    rationale: 'Source, asset and aggregation changes alter published prices that downstream contracts consume.',
  },
  api: {
    minNoticeDays: 7,
    material: true,
    rationale: 'REST/WebSocket consumers need time to adapt clients and regenerate SDKs.',
  },
  infrastructure: {
    minNoticeDays: 3,
    material: false,
    rationale: 'Deployment changes are announced for awareness; correctness remains covered by the SLO release gate.',
  },
  docs: {
    minNoticeDays: 0,
    material: false,
    rationale: 'Documentation-only changes do not require a review window.',
  },
};

export const RELEASE_REVIEW_POLICY = {
  version: '1.0.0',
  owner: 'Release Management with the Governance Working Group',
  cadence: 'Windows open when the release is announced and close 24h before the planned release date.',
  feedbackChannels: [
    'The GitHub issue linked from the release entry (public, threaded, searchable)',
    'The monthly community call agenda item for material releases',
    'The release notes "Breaking changes" section for consumer impact',
  ],
  channelsRequiredForMaterialReleases: 1,
  breakingChangeExtraDays: BREAKING_CHANGE_EXTRA_DAYS,
  reviewCloseLeadHours: REVIEW_CLOSE_LEAD_HOURS,
  emergency: {
    minNoticeHours: EMERGENCY_MIN_NOTICE_HOURS,
    retrospectiveWithinHours: EMERGENCY_RETROSPECTIVE_WITHIN_HOURS,
    requiresGuardianDeclaration: true,
  },
  classes: CHANGE_CLASS_RULES,
} as const;

const HOUR_MS = 3_600_000;

export type ReleaseLifecycleStatus = 'scheduled' | 'open' | 'released' | 'withdrawn' | 'invalid';

export interface ReleaseReviewEvaluation {
  id: string;
  version: string;
  summary: string;
  owner: string;
  status: ReleaseLifecycleStatus;
  changeClasses: Array<{ class: ChangeClass; minNoticeDays: number; material: boolean; breaking: boolean }>;
  announcedAt: string;
  releaseAt: string;
  reviewWindow: {
    opensAt: string;
    closesAt: string;
  };
  requiredNoticeDays: number;
  noticeDays: number;
  noticeShortfallDays: number;
  feedbackChannels: string[];
  emergency: {
    declaredBy: string;
    declaredAt: string;
    retrospectiveAt: string;
    retrospectiveDueBy: string;
  } | null;
  compliant: boolean;
  violations: string[];
  warnings: string[];
}

function requiredNoticeDays(entry: ReleaseReviewEntry): number {
  const classMaximum = Math.max(
    ...entry.changes.map((change) => CHANGE_CLASS_RULES[change.class].minNoticeDays),
  );
  const breaking = entry.changes.some((change) => change.breaking === true);
  return classMaximum + (breaking ? BREAKING_CHANGE_EXTRA_DAYS : 0);
}

function isMaterial(entry: ReleaseReviewEntry): boolean {
  return entry.changes.some(
    (change) =>
      change.breaking === true || CHANGE_CLASS_RULES[change.class].material,
  );
}

export function evaluateReleaseReview(
  entry: ReleaseReviewEntry,
  now: Date = new Date(),
): ReleaseReviewEvaluation {
  const announcedMs = Date.parse(entry.announcedAt);
  const releaseMs = Date.parse(entry.releaseAt);
  const nowMs = now.getTime();
  const noticeDays = (releaseMs - announcedMs) / 86_400_000;
  const required = requiredNoticeDays(entry);
  const violations: string[] = [];
  const warnings: string[] = [];

  let status: ReleaseLifecycleStatus;
  if (entry.status === 'withdrawn') {
    status = 'withdrawn';
  } else if (Number.isNaN(announcedMs) || Number.isNaN(releaseMs) || releaseMs <= announcedMs) {
    status = 'invalid';
  } else if (nowMs < announcedMs) {
    status = 'scheduled';
  } else if (nowMs < releaseMs) {
    status = 'open';
  } else {
    status = 'released';
  }

  if (status === 'withdrawn') {
    return {
      id: entry.id,
      version: entry.version,
      summary: entry.summary,
      owner: entry.owner,
      status,
      changeClasses: entry.changes.map((change) => ({
        class: change.class,
        minNoticeDays: CHANGE_CLASS_RULES[change.class].minNoticeDays,
        material: CHANGE_CLASS_RULES[change.class].material,
        breaking: change.breaking === true,
      })),
      announcedAt: entry.announcedAt,
      releaseAt: entry.releaseAt,
      reviewWindow: {
        opensAt: entry.announcedAt,
        closesAt: entry.releaseAt,
      },
      requiredNoticeDays: required,
      noticeDays: Number.isFinite(noticeDays) ? Math.round(noticeDays * 100) / 100 : 0,
      noticeShortfallDays: 0,
      feedbackChannels: entry.feedbackChannels,
      emergency: null,
      compliant: true,
      violations: [],
      warnings: ['release withdrawn; remaining review obligations cancelled'],
    };
  }

  if (status === 'invalid') {
    violations.push('invalid_schedule: releaseAt must be after announcedAt');
  }

  const effectiveRequired = entry.emergency ? EMERGENCY_MIN_NOTICE_HOURS / 24 : required;
  const shortfall = Math.max(0, effectiveRequired - noticeDays);
  if (Number.isFinite(noticeDays) && shortfall > 0) {
    violations.push(
      `insufficient_notice: ${Math.round(noticeDays * 100) / 100}d announced vs ${effectiveRequired}d required`,
    );
  }

  const material = isMaterial(entry);
  const minimumChannels = material ? RELEASE_REVIEW_POLICY.channelsRequiredForMaterialReleases : 0;
  if (entry.feedbackChannels.length < minimumChannels) {
    violations.push(
      `missing_feedback_channel: material release needs at least ${minimumChannels} actionable channel`,
    );
  }
  if (entry.owner.trim().length === 0) {
    violations.push('missing_owner: every release entry needs an accountable owner');
  }
  if (entry.feedbackChannels.length === 0 && !material) {
    warnings.push('no_feedback_channel: docs/infrastructure releases are announced without a channel');
  }

  const reviewWindowCloseMs = releaseMs - REVIEW_CLOSE_LEAD_HOURS * HOUR_MS;
  if (status === 'open' && nowMs > reviewWindowCloseMs) {
    warnings.push(
      'review_window_closed: release is inside the final 24h; only blocking corrections should be accepted',
    );
  }

  let emergency: ReleaseReviewEvaluation['emergency'] = null;
  if (entry.emergency) {
    const declaredMs = Date.parse(entry.emergency.declaredAt);
    const retrospectiveMs = Date.parse(entry.emergency.retrospectiveAt);
    const retrospectiveDueBy = new Date(releaseMs + EMERGENCY_RETROSPECTIVE_WITHIN_HOURS * HOUR_MS);
    emergency = {
      declaredBy: entry.emergency.declaredBy,
      declaredAt: entry.emergency.declaredAt,
      retrospectiveAt: entry.emergency.retrospectiveAt,
      retrospectiveDueBy: retrospectiveDueBy.toISOString(),
    };
    if (declaredMs > releaseMs) {
      violations.push('emergency_declared_after_release');
    }
    if (retrospectiveMs < releaseMs) {
      violations.push('retrospective_scheduled_before_release');
    } else if (retrospectiveMs > retrospectiveDueBy.getTime()) {
      violations.push(
        `retrospective_too_late: must be held within ${EMERGENCY_RETROSPECTIVE_WITHIN_HOURS}h of release`,
      );
    }
    warnings.push('emergency_release: post-incident review is required and tracked separately');
  }

  if (status === 'released' && material && entry.feedbackChannels.length === 0) {
    warnings.push('released_without_channel: record the feedback that was received for the audit trail');
  }

  return {
    id: entry.id,
    version: entry.version,
    summary: entry.summary,
    owner: entry.owner,
    status,
    changeClasses: entry.changes.map((change) => ({
      class: change.class,
      minNoticeDays: CHANGE_CLASS_RULES[change.class].minNoticeDays,
      material: CHANGE_CLASS_RULES[change.class].material,
      breaking: change.breaking === true,
    })),
    announcedAt: entry.announcedAt,
    releaseAt: entry.releaseAt,
    reviewWindow: {
      opensAt: entry.announcedAt,
      closesAt: new Date(reviewWindowCloseMs).toISOString(),
    },
    requiredNoticeDays: required,
    noticeDays: Number.isFinite(noticeDays) ? Math.round(noticeDays * 100) / 100 : 0,
    noticeShortfallDays: Math.round(shortfall * 100) / 100,
    feedbackChannels: entry.feedbackChannels,
    emergency,
    compliant: violations.length === 0,
    violations,
    warnings,
  };
}

export interface ReleaseReviewReport {
  generatedAt: string;
  asOf: string;
  policy: typeof RELEASE_REVIEW_POLICY;
  summary: {
    total: number;
    compliant: number;
    nonCompliant: number;
    open: number;
    scheduled: number;
    released: number;
    withdrawn: number;
    emergency: number;
  };
  releases: ReleaseReviewEvaluation[];
}

export function computeReleaseReviewReport(
  snapshot: ReleaseReviewSnapshot,
  now: Date = new Date(),
): ReleaseReviewReport {
  const releases = snapshot.releases
    .map((entry) => evaluateReleaseReview(entry, now))
    .sort((a, b) => Date.parse(a.releaseAt) - Date.parse(b.releaseAt));

  const countBy = (predicate: (release: ReleaseReviewEvaluation) => boolean): number =>
    releases.filter(predicate).length;

  return {
    generatedAt: now.toISOString(),
    asOf: snapshot.asOf,
    policy: RELEASE_REVIEW_POLICY,
    summary: {
      total: releases.length,
      compliant: countBy((release) => release.compliant),
      nonCompliant: countBy((release) => !release.compliant),
      open: countBy((release) => release.status === 'open'),
      scheduled: countBy((release) => release.status === 'scheduled'),
      released: countBy((release) => release.status === 'released'),
      withdrawn: countBy((release) => release.status === 'withdrawn'),
      emergency: countBy((release) => release.emergency !== null),
    },
    releases,
  };
}

/** Releases whose review window is still actionable and therefore gated in CI. */
export function gatedReleaseViolations(report: ReleaseReviewReport): ReleaseReviewEvaluation[] {
  return report.releases.filter(
    (release) =>
      !release.compliant &&
      release.status !== 'withdrawn' &&
      release.status !== 'released',
  );
}
