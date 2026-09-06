export type AlertType = 'deviation' | 'stale' | 'source_down' | 'sla_breach';

export type EscalationSeverity = 'critical' | 'warning' | 'info';
export type EscalationChannel = 'pagerduty' | 'opsgenie' | 'slack';

export interface EscalationPolicyInput {
  type: AlertType;
  asset: string;
  message: string;
}

export interface EscalationRoute {
  severity: EscalationSeverity;
  primaryChannel: EscalationChannel;
  primaryTarget: 'primary-oncall' | 'team-channel';
  secondaryTarget: 'engineering-manager' | 'team-lead' | 'none';
  ackWindowMinutes: number;
  runbook: string;
}

export function resolveEscalationRoute(input: EscalationPolicyInput): EscalationRoute {
  const message = input.message.toLowerCase();

  if (input.type === 'source_down' || input.type === 'sla_breach' || message.includes('all sources down') || message.includes('critical')) {
    return {
      severity: 'critical',
      primaryChannel: 'pagerduty',
      primaryTarget: 'primary-oncall',
      secondaryTarget: 'engineering-manager',
      ackWindowMinutes: 15,
      runbook: 'docs/runbooks/oracle-source-down.md',
    };
  }

  if (input.type === 'stale' || message.includes('stale') || message.includes('degraded')) {
    return {
      severity: 'warning',
      primaryChannel: 'opsgenie',
      primaryTarget: 'primary-oncall',
      secondaryTarget: 'team-lead',
      ackWindowMinutes: 30,
      runbook: 'docs/runbooks/price-feed-stale.md',
    };
  }

  return {
    severity: 'info',
    primaryChannel: 'slack',
    primaryTarget: 'team-channel',
    secondaryTarget: 'none',
    ackWindowMinutes: 240,
    runbook: 'docs/runbooks/price-anomaly.md',
  };
}
