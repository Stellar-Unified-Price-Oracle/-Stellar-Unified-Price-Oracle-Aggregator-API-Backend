import { describe, it, expect } from 'vitest';
import {
  computeReleaseReviewReport,
  evaluateReleaseReview,
  gatedReleaseViolations,
} from '../../src/governance/transparency/release-review';
import type { ReleaseReviewEntry } from '../../src/governance/transparency/schema';

function entry(overrides: Partial<ReleaseReviewEntry> = {}): ReleaseReviewEntry {
  return {
    id: 'rel-1',
    version: 'v1.2.0',
    summary: 'Raise the deviation threshold',
    owner: 'Release Management',
    changes: [{ class: 'contract', description: 'SetDeviationThreshold(500)' }],
    announcedAt: '2026-10-01T00:00:00.000Z',
    releaseAt: '2026-10-15T00:00:00.000Z',
    feedbackChannels: ['https://github.com/Stellar-Unified-Price-Oracle/issues/1'],
    status: 'planned',
    ...overrides,
  };
}

describe('community release review windows (#779)', () => {
  it('accepts a contract change announced exactly the minimum notice in advance', () => {
    const evaluation = evaluateReleaseReview(entry(), new Date('2026-10-05T00:00:00.000Z'));

    expect(evaluation.requiredNoticeDays).toBe(14);
    expect(evaluation.noticeDays).toBe(14);
    expect(evaluation.noticeShortfallDays).toBe(0);
    expect(evaluation.compliant).toBe(true);
    expect(evaluation.status).toBe('open');
    expect(evaluation.violations).toEqual([]);
  });

  it('rejects a contract change one hour short of the minimum notice', () => {
    const evaluation = evaluateReleaseReview(
      entry({ releaseAt: '2026-10-14T23:00:00.000Z' }),
      new Date('2026-10-05T00:00:00.000Z'),
    );

    expect(evaluation.noticeDays).toBe(13.96);
    expect(evaluation.noticeShortfallDays).toBe(0.04);
    expect(evaluation.compliant).toBe(false);
    expect(evaluation.violations).toContainEqual(expect.stringContaining('insufficient_notice'));
  });

  it('extends the window for breaking changes', () => {
    const evaluation = evaluateReleaseReview(
      entry({ changes: [{ class: 'contract', description: 'Breaking storage layout', breaking: true }] }),
      new Date('2026-10-05T00:00:00.000Z'),
    );

    expect(evaluation.requiredNoticeDays).toBe(21);
    expect(evaluation.compliant).toBe(false);
  });

  it('treats docs-only changes as needing no review window', () => {
    const evaluation = evaluateReleaseReview(
      entry({
        changes: [{ class: 'docs', description: 'Clarify decimals guidance' }],
        announcedAt: '2026-10-14T23:00:00.000Z',
        releaseAt: '2026-10-15T00:00:00.000Z',
        feedbackChannels: [],
      }),
      new Date('2026-10-14T23:30:00.000Z'),
    );

    expect(evaluation.requiredNoticeDays).toBe(0);
    expect(evaluation.compliant).toBe(true);
  });

  it('requires an actionable feedback channel for material releases', () => {
    const evaluation = evaluateReleaseReview(
      entry({ feedbackChannels: [] }),
      new Date('2026-10-05T00:00:00.000Z'),
    );

    expect(evaluation.compliant).toBe(false);
    expect(evaluation.violations).toContainEqual(
      expect.stringContaining('missing_feedback_channel'),
    );
  });

  it('accepts an emergency release with 24h notice and a retrospective inside 48h', () => {
    const evaluation = evaluateReleaseReview(
      entry({
        announcedAt: '2026-10-14T00:00:00.000Z',
        releaseAt: '2026-10-15T00:00:00.000Z',
        emergency: {
          declaredBy: 'guardian',
          declaredAt: '2026-10-14T00:00:00.000Z',
          reason: 'Compromised oracle source requires immediate threshold change',
          retrospectiveAt: '2026-10-16T00:00:00.000Z',
        },
      }),
      new Date('2026-10-14T12:00:00.000Z'),
    );

    expect(evaluation.compliant).toBe(true);
    expect(evaluation.emergency?.retrospectiveDueBy).toBe('2026-10-17T00:00:00.000Z');
    expect(evaluation.warnings).toContainEqual(expect.stringContaining('emergency_release'));
  });

  it('rejects an emergency retrospective scheduled outside the 48h window', () => {
    const evaluation = evaluateReleaseReview(
      entry({
        announcedAt: '2026-10-14T00:00:00.000Z',
        releaseAt: '2026-10-15T00:00:00.000Z',
        emergency: {
          declaredBy: 'guardian',
          declaredAt: '2026-10-14T00:00:00.000Z',
          reason: 'Critical security fix',
          retrospectiveAt: '2026-10-18T00:00:00.000Z',
        },
      }),
      new Date('2026-10-14T12:00:00.000Z'),
    );

    expect(evaluation.compliant).toBe(false);
    expect(evaluation.violations).toContainEqual(expect.stringContaining('retrospective_too_late'));
  });

  it('still enforces 24h notice for emergency releases', () => {
    const evaluation = evaluateReleaseReview(
      entry({
        announcedAt: '2026-10-14T12:00:00.000Z',
        releaseAt: '2026-10-15T00:00:00.000Z',
        emergency: {
          declaredBy: 'guardian',
          declaredAt: '2026-10-14T12:00:00.000Z',
          reason: 'Critical security fix',
          retrospectiveAt: '2026-10-16T00:00:00.000Z',
        },
      }),
      new Date('2026-10-14T13:00:00.000Z'),
    );

    expect(evaluation.compliant).toBe(false);
    expect(evaluation.violations).toContainEqual(expect.stringContaining('insufficient_notice'));
  });

  it('accepts a withdrawn release without requiring the window', () => {
    const evaluation = evaluateReleaseReview(
      entry({ status: 'withdrawn', feedbackChannels: [] }),
      new Date('2026-10-05T00:00:00.000Z'),
    );

    expect(evaluation.status).toBe('withdrawn');
    expect(evaluation.compliant).toBe(true);
    expect(evaluation.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('release withdrawn')]),
    );
  });

  it('rejects a release scheduled before its announcement', () => {
    const evaluation = evaluateReleaseReview(
      entry({ announcedAt: '2026-10-15T00:00:00.000Z', releaseAt: '2026-10-14T00:00:00.000Z' }),
      new Date('2026-10-10T00:00:00.000Z'),
    );

    expect(evaluation.status).toBe('invalid');
    expect(evaluation.compliant).toBe(false);
    expect(evaluation.violations).toContainEqual(
      expect.stringContaining('invalid_schedule'),
    );
  });

  it('reports the open/scheduled/released split and only gates actionable violations', () => {
    const report = computeReleaseReviewReport(
      {
        asOf: '2026-10-10T00:00:00.000Z',
        releases: [
          entry({ id: 'open-ok' }),
          entry({
            id: 'open-bad',
            announcedAt: '2026-10-09T00:00:00.000Z',
            releaseAt: '2026-10-15T00:00:00.000Z',
          }),
          entry({
            id: 'already-released-bad',
            announcedAt: '2026-09-01T00:00:00.000Z',
            releaseAt: '2026-09-02T00:00:00.000Z',
            feedbackChannels: [],
          }),
          entry({ id: 'future', announcedAt: '2026-11-01T00:00:00.000Z', releaseAt: '2026-11-20T00:00:00.000Z' }),
        ],
      },
      new Date('2026-10-10T00:00:00.000Z'),
    );

    expect(report.summary.total).toBe(4);
    expect(report.summary.open).toBe(2);
    expect(report.summary.released).toBe(1);
    expect(report.summary.scheduled).toBe(1);
    expect(report.summary.nonCompliant).toBe(2);

    const gated = gatedReleaseViolations(report).map((release) => release.id);
    expect(gated).toEqual(['open-bad']);
  });
});
