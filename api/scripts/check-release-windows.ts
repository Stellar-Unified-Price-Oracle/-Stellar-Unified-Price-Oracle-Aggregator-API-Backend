#!/usr/bin/env tsx
/**
 * Gate scheduled releases on the community review window policy (issue #779).
 *
 * Reads the release calendar from GOVERNANCE_TRANSPARENCY_DIR/release-review.json
 * (default api/data/governance) and evaluates every entry against
 * docs/governance/COMMUNITY_RELEASE_REVIEW.md.
 *
 * Usage:
 *   tsx api/scripts/check-release-windows.ts [--json] [--strict] [--now <iso>]
 *
 * Exit codes:
 *   0  no actionable release violates the policy
 *   1  at least one scheduled/open release violates the policy
 *   2  the release calendar is missing or invalid
 *
 * --strict also fails on already-released entries that violated the policy.
 * Without it, a historical violation is reported but does not block CI.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  computeReleaseReviewReport,
  gatedReleaseViolations,
} from '../src/governance/transparency/release-review';
import { readArtifact, TransparencyStoreError } from '../src/governance/transparency/store';
import { releaseReviewSnapshotSchema } from '../src/governance/transparency/schema';
import type { ReleaseReviewEvaluation } from '../src/governance/transparency/release-review';

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const asJson = args.includes('--json');
const strict = args.includes('--strict');
const nowArg = flag('now');
const now = nowArg ? new Date(nowArg) : new Date();

if (Number.isNaN(now.getTime())) {
  console.error(`Invalid --now value: ${nowArg}`);
  process.exit(2);
}

function printEvaluation(release: ReleaseReviewEvaluation): void {
  const window = `${release.announcedAt} -> ${release.releaseAt}`;
  console.log(
    `- ${release.version} (${release.id}) ${release.status.toUpperCase()} | window ${window} | notice ${release.noticeDays}d / required ${release.requiredNoticeDays}d`,
  );
  for (const violation of release.violations) {
    console.log(`    violation: ${violation}`);
  }
  for (const warning of release.warnings) {
    console.log(`    warning:   ${warning}`);
  }
}

try {
  const { data: snapshot, path: artifactPath } = readArtifact(
    'release-review.json',
    releaseReviewSnapshotSchema,
  );
  const report = computeReleaseReviewReport(snapshot, now);
  const gated = gatedReleaseViolations(report);
  const historical = report.releases.filter(
    (release) => !release.compliant && release.status === 'released',
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt: report.generatedAt,
          artifact: artifactPath,
          summary: report.summary,
          gatedViolations: gated.map((release) => release.id),
          historicalViolations: historical.map((release) => release.id),
          releases: report.releases,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Release review windows (${report.summary.total} entries, evaluated at ${report.generatedAt})`);
    console.log(`Source: ${artifactPath}`);
    console.log(
      `Compliant ${report.summary.compliant} | non-compliant ${report.summary.nonCompliant} | open windows ${report.summary.open} | scheduled ${report.summary.scheduled}`,
    );
    if (report.releases.length > 0) {
      console.log('');
      for (const release of report.releases) printEvaluation(release);
    }
  }

  if (gated.length > 0) {
    console.error(
      `\n${gated.length} release(s) violate the community review window policy: ${gated
        .map((release) => release.id)
        .join(', ')}`,
    );
    process.exit(1);
  }
  if (strict && historical.length > 0) {
    console.error(
      `\n--strict: ${historical.length} already-released entr(ies) violated the policy: ${historical
        .map((release) => release.id)
        .join(', ')}`,
    );
    process.exit(1);
  }

  console.log('\nRelease review window policy satisfied.');
} catch (err: unknown) {
  if (err instanceof TransparencyStoreError) {
    console.error(`Unable to evaluate release windows (${err.code}): ${err.message}`);
  } else {
    console.error('Unable to evaluate release windows:', err);
  }
  process.exit(2);
}
