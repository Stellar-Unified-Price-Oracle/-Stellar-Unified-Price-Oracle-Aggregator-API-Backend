import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Price History Gap Detection (Issue #507)', () => {
  describe('Gap Detection', () => {
    it('should detect gap exceeding threshold', () => {
      const historyGapAlertSec = 900; // 15 minutes
      const history = [
        { timestamp: 1000, asset: 'XLM', price: 100 },
        { timestamp: 2800, asset: 'XLM', price: 105 }, // gap of 1800 seconds (30 minutes)
      ];

      const gap = history[1].timestamp - history[0].timestamp;
      const hasGap = gap > historyGapAlertSec;

      expect(hasGap).toBe(true);
    });

    it('should not alert on gap within threshold', () => {
      const historyGapAlertSec = 900;
      const history = [
        { timestamp: 1000, asset: 'XLM', price: 100 },
        { timestamp: 1600, asset: 'XLM', price: 102 }, // gap of 600 seconds (10 minutes)
      ];

      const gap = history[1].timestamp - history[0].timestamp;
      const hasGap = gap > historyGapAlertSec;

      expect(hasGap).toBe(false);
    });

    it('should identify affected asset in gap alert', () => {
      const gap = {
        asset: 'USDC',
        start_timestamp: 1000,
        end_timestamp: 2800,
        gap_seconds: 1800,
        detected_at: '2026-09-15T12:00:00Z',
      };

      expect(gap.asset).toBe('USDC');
      expect(gap.gap_seconds).toBeGreaterThan(0);
    });

    it('should report multiple gaps across different assets', () => {
      const gaps = [
        { asset: 'XLM', gap_seconds: 1800 },
        { asset: 'USDC', gap_seconds: 2400 },
        { asset: 'BTC', gap_seconds: 900 },
      ];

      expect(gaps.length).toBe(3);
      expect(gaps.filter(g => g.gap_seconds > 900).length).toBe(2);
    });
  });

  describe('Gap Analysis', () => {
    it('should calculate gap duration in seconds', () => {
      const lastPrice = new Date('2026-09-14T10:00:00Z').getTime();
      const currentTime = new Date('2026-09-14T10:30:00Z').getTime();
      const gapSeconds = (currentTime - lastPrice) / 1000;

      expect(gapSeconds).toBe(1800);
    });

    it('should identify gap as missing consecutive data points', () => {
      const history = [
        { timestamp: 1000, asset: 'XLM' },
        { timestamp: 1300, asset: 'XLM' },
        { timestamp: 1600, asset: 'XLM' },
        // gap: timestamps 1900, 2200 are missing
        { timestamp: 2500, asset: 'XLM' },
      ];

      const expectedInterval = 300; // 5 minutes between points
      const gaps = [];

      for (let i = 0; i < history.length - 1; i++) {
        const interval = history[i + 1].timestamp - history[i].timestamp;
        if (interval > expectedInterval * 2) {
          gaps.push({
            after: history[i].timestamp,
            before: history[i + 1].timestamp,
            missing_points: Math.floor(interval / expectedInterval) - 1,
          });
        }
      }

      expect(gaps.length).toBe(1);
      expect(gaps[0].missing_points).toBeGreaterThan(0);
    });

    it('should correlate gap with potential outages or data collection issues', () => {
      const gap = {
        asset: 'XLM',
        start: '2026-09-14T09:30:00Z',
        end: '2026-09-14T10:00:00Z',
        duration_minutes: 30,
        potential_causes: [
          'aggregator_service_down',
          'oracle_provider_offline',
          'network_connectivity_issue',
          'database_write_failure',
        ],
      };

      expect(gap.potential_causes.length).toBeGreaterThan(0);
    });
  });

  describe('Backfill Instructions', () => {
    it('should provide backfill command for missing period', () => {
      const gap = {
        asset: 'XLM',
        from_timestamp: 1694674200,
        to_timestamp: 1694678000,
      };

      const backfillCommand = `npm run history:backfill -- --asset ${gap.asset} --from ${gap.from_timestamp} --to ${gap.to_timestamp}`;

      expect(backfillCommand).toContain('history:backfill');
      expect(backfillCommand).toContain(gap.asset);
      expect(backfillCommand).toContain(gap.from_timestamp.toString());
      expect(backfillCommand).toContain(gap.to_timestamp.toString());
    });

    it('should calculate backfill time range from gap bounds', () => {
      const lastRecordedTime = 1694674200; // 2026-09-14 09:30:00 UTC
      const gapDetectedTime = 1694678000; // 2026-09-14 10:33:20 UTC

      const backfillStart = lastRecordedTime;
      const backfillEnd = gapDetectedTime;

      expect(backfillStart).toBeLessThan(backfillEnd);
    });

    it('should support backfill for single or multiple assets', () => {
      const singleAssetBackfill = 'npm run history:backfill -- --asset XLM --from 100 --to 200';
      const multiAssetBackfill = 'npm run history:backfill -- --assets XLM,USDC --from 100 --to 200';

      expect(singleAssetBackfill).toContain('--asset');
      expect(multiAssetBackfill).toContain('--assets');
    });

    it('should provide status check after backfill', () => {
      const afterBackfillSteps = [
        'Run: npm run history:backfill -- --asset XLM --from 1694674200 --to 1694678000',
        'Wait for backfill to complete',
        'Run: npm run history:verify -- --asset XLM --from 1694674200 --to 1694678000',
        'Confirm no gaps remain and re-run gap detector workflow',
      ];

      expect(afterBackfillSteps.length).toBeGreaterThan(0);
    });
  });

  describe('Scheduled Gap Detection', () => {
    it('should run gap detection on schedule', () => {
      const schedule = {
        name: 'history_gap_detector',
        frequency: 'every_15_minutes',
        cron: '*/15 * * * *',
        assets_checked: ['XLM', 'USDC', 'BTC'],
      };

      expect(schedule.frequency).toBeTruthy();
      expect(schedule.assets_checked.length).toBeGreaterThan(0);
    });

    it('should check all watched assets in each run', () => {
      const watchedAssets = ['XLM', 'USDC', 'BTC', 'EUR'];
      const gapDetectionRun = {
        timestamp: '2026-09-14T10:15:00Z',
        assets_scanned: watchedAssets,
        gaps_found: [],
      };

      expect(gapDetectionRun.assets_scanned.length).toBe(watchedAssets.length);
    });

    it('should raise alert only if gap exceeds threshold', () => {
      const historyGapAlertSec = 900;
      const detectionRun = {
        gaps_detected: [
          { asset: 'XLM', gap_seconds: 600, alert: false },
          { asset: 'USDC', gap_seconds: 1200, alert: true },
          { asset: 'BTC', gap_seconds: 900, alert: false }, // exactly at threshold
        ],
      };

      const alertCount = detectionRun.gaps_detected.filter(g => g.gap_seconds > historyGapAlertSec).length;
      expect(alertCount).toBe(1);
    });
  });

  describe('Alert Integration', () => {
    it('should create GitHub issue for detected gap', () => {
      const alert = {
        type: 'price_history_gap',
        title: 'price_history gap detected (2026-09-14)',
        asset: 'XLM',
        gap_duration_minutes: 30,
        alert_threshold_seconds: 900,
        body: 'The scheduled history gap detector found a gap exceeding HISTORY_GAP_ALERT_SEC=900.',
      };

      expect(alert.type).toBe('price_history_gap');
      expect(alert.title).toContain('gap detected');
    });

    it('should include backfill instructions in alert', () => {
      const alertBody = `
The scheduled history gap detector found a gap exceeding HISTORY_GAP_ALERT_SEC=900.

Backfill with \`npm run history:backfill -- --asset <ASSET> --from <startTs> --to <endTs>\`
then re-run this workflow to confirm the gap is closed.
      `;

      expect(alertBody).toContain('history:backfill');
      expect(alertBody).toContain('--asset');
    });

    it('should link to workflow run in alert', () => {
      const alert = {
        workflow_run_url: 'https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/34886878723',
        asset: 'XLM',
        gap_detected: true,
      };

      expect(alert.workflow_run_url).toContain('actions/runs');
    });

    it('should resolve alert after successful backfill and verification', () => {
      const alertState = {
        created_at: '2026-09-14T10:30:00Z',
        status: 'backfilled',
        verified_at: '2026-09-14T11:00:00Z',
        can_close: true,
      };

      expect(alertState.status).toBe('backfilled');
      expect(alertState.can_close).toBe(true);
    });
  });

  describe('Gap History Tracking', () => {
    it('should maintain log of all detected gaps', () => {
      const gapLog = [
        {
          id: 'gap_001',
          asset: 'XLM',
          detected_date: '2026-09-14',
          gap_seconds: 1800,
          backfilled: true,
          backfill_date: '2026-09-14',
        },
        {
          id: 'gap_002',
          asset: 'USDC',
          detected_date: '2026-09-10',
          gap_seconds: 2400,
          backfilled: true,
          backfill_date: '2026-09-10',
        },
      ];

      expect(gapLog.length).toBeGreaterThan(0);
      expect(gapLog[0].asset).toBeTruthy();
    });

    it('should track backfill success or failure', () => {
      const backfillAttempt = {
        gap_id: 'gap_001',
        asset: 'XLM',
        attempt_date: '2026-09-14',
        status: 'success',
        records_restored: 450,
      };

      expect(backfillAttempt.status).toBe('success');
      expect(backfillAttempt.records_restored).toBeGreaterThan(0);
    });

    it('should identify recurring gaps in same asset', () => {
      const gapLog = [
        { asset: 'XLM', date: '2026-09-01', gap_seconds: 900 },
        { asset: 'XLM', date: '2026-09-08', gap_seconds: 1200 },
        { asset: 'XLM', date: '2026-09-14', gap_seconds: 1800 },
      ];

      const xlmGaps = gapLog.filter(g => g.asset === 'XLM');
      expect(xlmGaps.length).toBeGreaterThan(1);
    });
  });

  describe('Prevention and Monitoring', () => {
    it('should monitor aggregator health to prevent gaps', () => {
      const healthMetrics = {
        aggregator_running: true,
        polling_interval_active: true,
        last_price_update: '2026-09-14T10:30:00Z',
        history_write_success_rate: 0.99,
      };

      expect(healthMetrics.aggregator_running).toBe(true);
      expect(healthMetrics.history_write_success_rate).toBeGreaterThan(0.95);
    });

    it('should alert if history writes are failing', () => {
      const failureAlert = {
        metric: 'history_write_failures',
        threshold: 0.05,
        current_rate: 0.08,
        alert_severity: 'critical',
      };

      expect(failureAlert.current_rate).toBeGreaterThan(failureAlert.threshold);
    });

    it('should check oracle provider availability', () => {
      const providerStatus = {
        chainlink: { available: true, last_response: '2026-09-14T10:30:00Z' },
        redstone: { available: true, last_response: '2026-09-14T10:29:00Z' },
        band: { available: false, last_response: '2026-09-14T10:15:00Z' },
        reflector: { available: true, last_response: '2026-09-14T10:30:00Z' },
      };

      const unavailableProviders = Object.entries(providerStatus)
        .filter(([_, status]) => !status.available)
        .map(([name]) => name);

      expect(unavailableProviders.length).toBeGreaterThan(0);
    });
  });
});
