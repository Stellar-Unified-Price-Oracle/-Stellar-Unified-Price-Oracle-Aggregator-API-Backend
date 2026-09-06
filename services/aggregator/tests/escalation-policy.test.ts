import { describe, expect, it } from 'vitest';
import { resolveEscalationRoute } from '../src/observability/escalation-policy';

describe('Escalation policy', () => {
  it('routes critical production failures to PagerDuty primary on-call and manager escalation', () => {
    const route = resolveEscalationRoute({
      type: 'source_down',
      asset: 'XLM',
      message: 'All sources down for XLM',
    });

    expect(route.severity).toBe('critical');
    expect(route.primaryChannel).toBe('pagerduty');
    expect(route.primaryTarget).toBe('primary-oncall');
    expect(route.secondaryTarget).toBe('engineering-manager');
    expect(route.ackWindowMinutes).toBe(15);
  });

  it('routes degraded but recoverable issues to Opsgenie and team lead escalation', () => {
    const route = resolveEscalationRoute({
      type: 'stale',
      asset: 'BTC',
      message: 'Price data stale for BTC',
    });

    expect(route.severity).toBe('warning');
    expect(route.primaryChannel).toBe('opsgenie');
    expect(route.primaryTarget).toBe('primary-oncall');
    expect(route.secondaryTarget).toBe('team-lead');
    expect(route.ackWindowMinutes).toBe(30);
  });

  it('keeps informational noise out of pages and only notifies the team channel', () => {
    const route = resolveEscalationRoute({
      type: 'deviation',
      asset: 'ETH',
      message: 'Minor single-source drift',
    });

    expect(route.severity).toBe('info');
    expect(route.primaryChannel).toBe('slack');
    expect(route.primaryTarget).toBe('team-channel');
    expect(route.secondaryTarget).toBe('none');
  });
});
