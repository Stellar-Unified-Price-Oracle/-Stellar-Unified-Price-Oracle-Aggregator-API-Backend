import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { alertingGaps, buildAlertBody } = require('../scripts/history-gap-alert.cjs');

const RUN_URL = 'https://github.com/o/r/actions/runs/1';

function summary(gaps: Array<{ asset: string; startTs: number; endTs: number }>) {
  return {
    windowStart: '2026-10-18T00:00:00.000Z',
    alertThreshold: 900,
    gaps: gaps.map((g) => ({ ...g, gapSeconds: g.endTs - g.startTs, missingSnapshots: 0 })),
  };
}

describe('history gap alert body', () => {
  it('keeps only gaps above the alert threshold', () => {
    const s = summary([
      { asset: 'BTC', startTs: 1_000, endTs: 3_000 },
      { asset: 'XLM', startTs: 1_000, endTs: 1_120 },
    ]);
    expect(alertingGaps(s).map((g: { asset: string }) => g.asset)).toEqual(['BTC']);
  });

  it('lists each alerting gap with a ready-to-run backfill command', () => {
    const body = buildAlertBody(summary([{ asset: 'BTC', startTs: 1719378000, endTs: 1719379800 }]), RUN_URL);
    expect(body).toContain('found 1 gap(s)');
    expect(body).toContain(RUN_URL);
    expect(body).toContain('2024-06-26T05:00:00Z');
    expect(body).toContain('npm run history:backfill -- --asset BTC --from 1719378000 --to 1719379800');
    expect(body).not.toContain('<ASSET>');
  });

  it('truncates long gap lists and points to the run log', () => {
    const gaps = Array.from({ length: 30 }, (_, i) => ({ asset: `A${i}`, startTs: 0, endTs: 2_000 }));
    const body = buildAlertBody(summary(gaps), RUN_URL);
    expect(body.match(/history:backfill -- --asset/g)).toHaveLength(25);
    expect(body).toContain('and 5 more');
  });
});
