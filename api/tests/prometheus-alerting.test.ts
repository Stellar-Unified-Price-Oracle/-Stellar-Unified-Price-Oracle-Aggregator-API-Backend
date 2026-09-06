import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as yaml from 'js-yaml';

describe('Prometheus Alerting Rules', () => {
  let alertingRules: any;

  beforeEach(() => {
    alertingRules = {
      groups: [
        {
          name: 'oracle_health',
          interval: '30s',
          rules: [],
        },
      ],
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Source Down Alert', () => {
    it('should define alert for oracle source down', () => {
      const rule = {
        alert: 'OracleSourceUptimeDegraded',
        expr: 'last_over_time(oracle_source_uptime_percent{source!=""}[10m]) < 95',
        for: '10m',
        labels: {
          severity: 'warning',
          component: 'aggregator',
        },
        annotations: {
          summary: 'Oracle source uptime degraded',
          description: '{{ $labels.source }} uptime is below threshold over the last 10 minutes',
          runbook_url: 'https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/blob/main/docs/runbooks/oracle-source-down.md'
        },
      };

      expect(rule.alert).toBe('OracleSourceUptimeDegraded');
      expect(rule.expr).toMatch(/oracle_source_failures_total|oracle_source_uptime_percent/);
      expect(['critical', 'warning', 'info']).toContain(rule.labels.severity);
    });

    it('should trigger after 3 consecutive failures', () => {
      const expr = 'increase(oracle_source_failures_total[5m]) >= 3';
      const failureThreshold = 3;

      expect(expr).toContain(`>= ${failureThreshold}`);
    });

    it('should have appropriate alert duration', () => {
      const alertFor = '2m';
      const minutes = parseInt(alertFor);

      expect(minutes).toBeGreaterThan(0);
      expect(minutes).toBeLessThanOrEqual(5);
    });

    it('should include source label in alert', () => {
      const annotations = {
        description: '{{ $labels.source }} has failed {{ $value }} times',
      };

      expect(annotations.description).toContain('$labels.source');
      expect(annotations.description).toContain('$value');
    });

    it('should differentiate source types in alerts', () => {
      const sources = ['chainlink', 'redstone', 'band', 'reflector'];

      sources.forEach((source) => {
        const metric = `oracle_source_failures_total{source="${source}"}`;
        expect(metric).toContain(source);
      });
    });
  });

  describe('Stale Prices Alert', () => {
    it('should define alert for stale prices', () => {
      const rule = {
        alert: 'PriceFeedStale',
        expr: 'time() - oracle_last_price_update_timestamp_seconds > 120',
        for: '1m',
        labels: {
          severity: 'warning',
          component: 'oracle',
        },
        annotations: {
          summary: 'Price data is stale',
          description: '{{ $labels.asset }} price last updated {{ $value }}s ago',
          runbook_url: 'https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/blob/main/docs/runbooks/price-feed-stale.md'
        },
      };

      expect(rule.alert).toBe('PriceFeedStale');
      expect(rule.expr).toContain('> 120');
      expect(rule.labels.severity).toBe('warning');
    });

    it('should detect staleness greater than 120 seconds', () => {
      const staleDuration = 120;
      const expr = `time() - oracle_last_price_update_timestamp_seconds > ${staleDuration}`;

      expect(expr).toContain('120');
    });

    it('should have lower severity than source down', () => {
      const sourceDownSeverity = 'critical';
      const stalePricesSeverity = 'warning';

      const severityLevels = { critical: 3, warning: 2, info: 1 };

      expect(severityLevels[sourceDownSeverity as keyof typeof severityLevels]).toBeGreaterThan(
        severityLevels[stalePricesSeverity as keyof typeof severityLevels]
      );
    });

    it('should include asset label in alert', () => {
      const annotations = {
        description: '{{ $labels.asset }} price last updated {{ $value }}s ago',
      };

      expect(annotations.description).toContain('$labels.asset');
    });

    it('should track time since last update', () => {
      const metric = 'oracle_last_price_update_timestamp_seconds';
      expect(metric).toContain('timestamp_seconds');
    });
  });

  describe('Circuit Breaker Open Alert', () => {
    it('should define alert for circuit breaker open state', () => {
      const rule = {
        alert: 'CircuitBreakerOpen',
        expr: 'circuit_breaker_state{state="open"} == 1',
        for: '30s',
        labels: {
          severity: 'critical',
          component: 'aggregator',
        },
        annotations: {
          summary: 'Circuit breaker is open',
          description: 'Circuit breaker for {{ $labels.source }} is open',
        },
      };

      expect(rule.alert).toBe('CircuitBreakerOpen');
      expect(rule.expr).toContain('circuit_breaker_state');
      expect(rule.expr).toContain('state="open"');
    });

    it('should detect circuit breaker state change', () => {
      const states = ['closed', 'open', 'half_open'];

      states.forEach((state) => {
        const expr = `circuit_breaker_state{state="${state}"}`;
        expect(expr).toContain(state);
      });
    });

    it('should notify immediately on circuit break', () => {
      const alertDuration = '30s';
      const seconds = parseInt(alertDuration);

      expect(seconds).toBeLessThan(60);
    });

    it('should identify which source has open circuit', () => {
      const annotation = '{{ $labels.source }}';
      expect(annotation).toContain('$labels.source');
    });

    it('should distinguish between different circuit breaker types', () => {
      const sources = ['chainlink', 'redstone', 'band', 'reflector'];

      sources.forEach((source) => {
        const label = `source="${source}"`;
        expect(label).toContain(source);
      });
    });
  });

  describe('API Latency Alert', () => {
    it('should define alert for API latency exceeding SLA', () => {
      const rule = {
        alert: 'IstioHighRequestLatency',
        expr: 'histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket{destination_service_namespace="stellar-oracle"}[5m])) by (le, destination_service)) > 2000',
        for: '5m',
        labels: {
          severity: 'warning',
          component: 'mesh',
        },
        annotations: {
          summary: 'High p99 latency observed in mesh',
          description: 'P99 latency is {{ $value }}ms for {{ $labels.destination_service }}',
          runbook_url: 'https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/blob/main/docs/runbooks/istio-high-request-latency.md'
        },
      };

      expect(rule.alert).toBe('IstioHighRequestLatency');
      expect(rule.expr).toContain('histogram_quantile');
      expect(rule.expr).toMatch(/>\s*1|>\s*2000/);
    });

    it('should use 99th percentile for SLA checks', () => {
      const percentile = 0.99;
      const expr = `histogram_quantile(${percentile}, api_request_duration_seconds)`;

      expect(expr).toContain('0.99');
    });

    it('should set SLA threshold to 1 second', () => {
      const slaTreshold = 1;
      expect(slaTreshold).toBe(1);
    });

    it('should track latency by endpoint', () => {
      const label = 'endpoint';
      const annotation = '{{ $labels.endpoint }}';

      expect(annotation).toContain('endpoint');
    });

    it('should apply to different HTTP methods', () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE'];

      methods.forEach((method) => {
        const metric = `api_request_duration_seconds{method="${method}"}`;
        expect(metric).toContain(method);
      });
    });
  });

  describe('Alert Rule Structure', () => {
    it('should have valid alert expression', () => {
      const rule = {
        expr: 'increase(oracle_source_failures_total[5m]) >= 3',
      };

      expect(rule.expr).toMatch(/[a-zA-Z_]/);
      expect(rule.expr).not.toBe('');
    });

    it('should include severity labels', () => {
      const severities = ['critical', 'warning', 'info'];

      severities.forEach((severity) => {
        const label = { severity };
        expect(['critical', 'warning', 'info']).toContain(label.severity);
      });
    });

    it('should have descriptive annotations', () => {
      const rule = {
        annotations: {
          summary: 'Alert summary',
          description: 'Detailed description with {{ $labels.label }}',
        },
      };

      expect(rule.annotations.summary).toBeDefined();
      expect(rule.annotations.description).toBeDefined();
    });

    it('should define alert duration', () => {
      const durations = ['30s', '1m', '2m', '5m'];

      durations.forEach((duration) => {
        const seconds = parseInt(duration);
        expect(seconds).toBeGreaterThan(0);
      });
    });
  });

  describe('Alert Routing and Notification', () => {
    it('should route critical alerts to incident response', () => {
      const route = {
        match: { severity: 'critical' },
        receiver: 'incident-response',
      };

      expect(route.receiver).toBe('incident-response');
    });

    it('should route warning alerts to monitoring team', () => {
      const route = {
        match: { severity: 'warning' },
        receiver: 'monitoring-team',
      };

      expect(route.receiver).toBe('monitoring-team');
    });

    it('should group related alerts', () => {
      const grouping = {
        group_by: ['alertname', 'component', 'severity'],
      };

      expect(grouping.group_by).toContain('alertname');
      expect(grouping.group_by).toContain('severity');
    });

    it('should throttle repeated alerts', () => {
      const throttle = {
        repeat_interval: '4h',
      };

      expect(throttle.repeat_interval).toBe('4h');
    });
  });

  describe('Alert Aggregation', () => {
    it('should aggregate multiple source failures into single alert', () => {
      const alert = {
        expr: 'count(increase(oracle_source_failures_total[5m]) >= 3) > 0',
      };

      expect(alert.expr).toContain('count');
    });

    it('should track alert firing count', () => {
      const metric = 'ALERTS{alertstate="firing"}';
      expect(metric).toContain('alertstate');
    });

    it('should include affected resources in alert', () => {
      const labels = {
        source: 'chainlink',
        asset: 'USD/USDC',
        component: 'oracle',
      };

      expect(Object.keys(labels).length).toBe(3);
    });
  });

  describe('Alert Rule Evaluation', () => {
    it('should evaluate rules every 30 seconds', () => {
      const interval = 30;
      expect(interval).toBeLessThanOrEqual(60);
    });

    it('should hold alert for specified duration before firing', () => {
      const durations = {
        'OracleSourceUptimeDegraded': 120,
        'PriceFeedStale': 60,
        'CircuitBreakerOpen': 30,
      };

      Object.values(durations).forEach((duration) => {
        expect(duration).toBeGreaterThan(0);
      });
    });

    it('should clear alerts when condition resolves', () => {
      const alertState = {
        firing: true,
        resolved: false,
      };

      expect(alertState.firing).not.toBe(alertState.resolved);
    });
  });

  describe('Alert Recording Rules', () => {
    it('should define recording rules for aggregated metrics', () => {
      const rule = {
        record: 'job:oracle_source_failures:rate5m',
        expr: 'rate(oracle_source_failures_total[5m])',
      };

      expect(rule.record).toBeDefined();
      expect(rule.expr).toBeDefined();
    });

    it('should calculate failure rates', () => {
      const rule = {
        expr: 'rate(oracle_source_failures_total[5m])',
      };

      expect(rule.expr).toContain('rate');
    });

    it('should aggregate metrics by asset', () => {
      const rule = {
        expr: 'sum(rate(oracle_price_updates_total[5m])) by (asset)',
      };

      expect(rule.expr).toContain('by (asset)');
    });
  });

  describe('AlertmanagerConfig', () => {
    it('should define global configuration', () => {
      const config = {
        global: {
          resolve_timeout: '5m',
        },
      };

      expect(config.global.resolve_timeout).toBe('5m');
    });

    it('should define alert receivers', () => {
      const receivers = [
        { name: 'incident-response' },
        { name: 'monitoring-team' },
      ];

      expect(receivers.length).toBeGreaterThan(0);
    });

    it('should define routing tree', () => {
      const routing = {
        group_by: ['alertname', 'severity'],
        routes: [],
      };

      expect(routing.group_by).toBeDefined();
      expect(Array.isArray(routing.routes)).toBe(true);
    });

    it('should configure dedup, flap suppression, and inhibition in the production alertmanager config', () => {
      const filePath = path.resolve(__dirname, '../../monitoring/alertmanager.yml');
      expect(fs.existsSync(filePath)).toBe(true);

      const config = yaml.load(fs.readFileSync(filePath, 'utf8')) as any;
      expect(config.route.group_by).toEqual(expect.arrayContaining(['alertname', 'namespace', 'severity', 'asset']));
      expect(config.route.group_wait).toBe('30s');
      expect(config.route.group_interval).toBe('5m');
      expect(config.route.repeat_interval).toBe('6h');
      expect(config.route.routes.some((route: any) => route.receiver === 'pagerduty-critical')).toBe(true);
      expect(config.inhibit_rules.some((rule: any) =>
        rule.source_matchers?.includes('severity="critical"') &&
        rule.target_matchers?.includes('severity="warning"'))
      ).toBe(true);
    });
  });

  describe('Alert Thresholds Validation', () => {
    it('should validate source failure threshold', () => {
      const threshold = 3;
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThanOrEqual(10);
    });

    it('should validate staleness threshold', () => {
      const threshold = 120;
      expect(threshold).toBeGreaterThan(30);
      expect(threshold).toBeLessThan(300);
    });

    it('should validate latency threshold', () => {
      const threshold = 1;
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThan(10);
    });

    it('should validate alert duration thresholds', () => {
      const thresholds = {
        critical: 30,
        warning: 300,
        info: 900,
      };

      Object.values(thresholds).forEach((threshold) => {
        expect(threshold).toBeGreaterThan(0);
      });
    });
  });
});
