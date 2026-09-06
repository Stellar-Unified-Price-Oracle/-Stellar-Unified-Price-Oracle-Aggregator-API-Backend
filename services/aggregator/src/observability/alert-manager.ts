import fs from 'fs';
import path from 'path';
import { AggregatedPrice } from '../infrastructure/types';
import { logger } from './logger';
import { WebSocketServer } from '../infrastructure/ws-server';
import { resolveEscalationRoute } from './escalation-policy';

export interface AlertThresholds {
  asset: string;
  deviationThresholdPercent: number;
  staleThresholdSeconds: number;
  sourceDownThreshold: number;
}

export interface AlertEvent {
  timestamp: number;
  asset: string;
  type: 'deviation' | 'stale' | 'source_down' | 'sla_breach';
  message: string;
  previousPrice?: string;
  currentPrice?: string;
  deviationPercent?: number;
  affectedSources?: string[];
  source?: string;
  elapsedSeconds?: number;
  thresholdSeconds?: number;
}

export interface AlertConfig {
  webhookUrl?: string;
  webhookRetries?: number;
  webhookRetryDelayMs?: number;
  enableConsoleLog?: boolean;
  enableFileLog?: boolean;
  alertHistoryPath?: string;
  /** Slack incoming webhook URL */
  slackWebhookUrl?: string;
  /** PagerDuty Events API v2 integration/routing key */
  pagerDutyRoutingKey?: string;
  /** Opsgenie API key for routed incidents */
  opsGenieApiKey?: string;
  /** Generic transactional email API webhook (e.g. SendGrid/Mailgun) */
  emailWebhookUrl?: string;
  emailRecipients?: string[];
  /** Cross-source disagreement threshold, percent */
  sourceDisagreementThresholdPercent?: number;
  /** SLA breach alerting: max breaches per window before alert fires */
  slaBreachMaxPerWindow?: number;
  /** SLA breach alerting: rolling window in seconds */
  slaBreachWindowSeconds?: number;
  /** SLA threshold in seconds (must match SLA_THRESHOLD_SECONDS in base.ts) */
  slaThresholdSeconds?: number;
  /** Suppress identical alerts for this long after the first trigger */
  dedupWindowSeconds?: number;
  /** Suppress flapping alerts when the same key re-triggers too often */
  flapSuppressionWindowSeconds?: number;
  /** Number of re-triggers permitted in the flap suppression window */
  flapMaxTriggers?: number;
}

class AlertManager {
  private thresholds: Map<string, AlertThresholds> = new Map();
  private priceHistory: Map<string, AggregatedPrice> = new Map();
  private sourceFailureCount: Map<string, number> = new Map();
  private config: AlertConfig;
  private alertHistory: AlertEvent[] = [];
  private slaBreachTimestamps: Map<string, number[]> = new Map();
  private lastAlertAtByKey: Map<string, number> = new Map();
  private alertTriggerHistory: Map<string, number[]> = new Map();
  private static readonly DEFAULT_CONFIG: AlertConfig = {
    webhookRetries: 3,
    webhookRetryDelayMs: 1000,
    enableConsoleLog: true,
    enableFileLog: true,
    alertHistoryPath: path.resolve(__dirname, '../../data/alerts.jsonl'),
    slaBreachMaxPerWindow: 10,
    slaBreachWindowSeconds: 300,
    slaThresholdSeconds: 5,
    dedupWindowSeconds: 300,
    flapSuppressionWindowSeconds: 1800,
    flapMaxTriggers: 3,
  };

  constructor(config: Partial<AlertConfig> = {}) {
    this.config = { ...AlertManager.DEFAULT_CONFIG, ...config };
    this.ensureAlertDirectory();
  }

  private ensureAlertDirectory(): void {
    if (this.config.alertHistoryPath) {
      const dir = path.dirname(this.config.alertHistoryPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  setThresholds(thresholds: AlertThresholds[]): void {
    for (const t of thresholds) {
      this.thresholds.set(t.asset, t);
    }
  }

  async checkPrice(price: AggregatedPrice): Promise<void> {
    const asset = price.asset.toUpperCase();
    const threshold = this.thresholds.get(asset);

    if (!threshold) return;

    const previousPrice = this.priceHistory.get(asset);
    this.priceHistory.set(asset, price);

    // Check for price deviation
    if (previousPrice && threshold.deviationThresholdPercent > 0) {
      const previousValue = parseFloat(previousPrice.price);
      const currentValue = parseFloat(price.price);
      const deviationPercent = Math.abs((currentValue - previousValue) / previousValue) * 100;

      if (deviationPercent > threshold.deviationThresholdPercent) {
        await this.emitAlert({
          timestamp: Math.floor(Date.now() / 1000),
          asset,
          type: 'deviation',
          message: `Price deviation alert for ${asset}: ${deviationPercent.toFixed(2)}% change`,
          previousPrice: previousPrice.price,
          currentPrice: price.price,
          deviationPercent,
        });
      }
    }

    // Check for stale data
    if (threshold.staleThresholdSeconds > 0) {
      const ageSeconds = Math.floor(Date.now() / 1000) - price.timestamp;
      if (ageSeconds > threshold.staleThresholdSeconds) {
        await this.emitAlert({
          timestamp: Math.floor(Date.now() / 1000),
          asset,
          type: 'stale',
          message: `Price data stale for ${asset}: ${ageSeconds}s old (threshold: ${threshold.staleThresholdSeconds}s)`,
        });
      }
    }

    // Check for source failures
    if (threshold.sourceDownThreshold > 0) {
      const failureKey = `${asset}:failures`;
      const currentFailures = this.sourceFailureCount.get(failureKey) || 0;
      if (price.sources.length === 0) {
        this.sourceFailureCount.set(failureKey, currentFailures + 1);
        if (currentFailures >= threshold.sourceDownThreshold) {
          await this.emitAlert({
            timestamp: Math.floor(Date.now() / 1000),
            asset,
            type: 'source_down',
            message: `All sources down for ${asset} (${currentFailures} consecutive failures)`,
          });
        }
      } else {
        this.sourceFailureCount.set(failureKey, 0);
      }
    }
  }

  /**
   * Records an SLA breach and fires an alert when the rolling-window rate
   * exceeds the configured threshold.
   */
  async checkSlaBreach(source: string, asset: string, elapsedSeconds: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const key = `${source}:${asset}`;
    const timestamps = this.slaBreachTimestamps.get(key) || [];

    const windowStart = now - (this.config.slaBreachWindowSeconds ?? 300);
    const recent = timestamps.filter((t) => t >= windowStart);
    recent.push(now);
    this.slaBreachTimestamps.set(key, recent);

    const thresholdSeconds = this.config.slaThresholdSeconds ?? 5;
    if (recent.length > (this.config.slaBreachMaxPerWindow ?? 10)) {
      await this.emitAlert({
        timestamp: now,
        asset,
        type: 'sla_breach',
        message: `SLA breach threshold exceeded for ${source}/${asset}: ${recent.length} breaches in ${this.config.slaBreachWindowSeconds ?? 300}s (max: ${this.config.slaBreachMaxPerWindow ?? 10})`,
        source,
        elapsedSeconds,
        thresholdSeconds,
      });

      this.slaBreachTimestamps.set(key, []);
    }
  }

  /**
   * Issue #382 — on-chain price staleness heartbeat.
   *
   * Unlike checkPrice()'s `stale` check (which watches the aggregator's own
   * in-memory price cache), this watches the timestamp actually stored on
   * the oracle contract, so it still fires if the contract silently stops
   * receiving submissions even though the aggregator process looks healthy.
   * Returns whether the asset is currently stale, for the caller's metrics.
   */
  async checkOnChainHeartbeat(
    asset: string,
    latestOnChainTimestamp: number,
    thresholdSeconds: number,
  ): Promise<boolean> {
    const ageSeconds = Math.floor(Date.now() / 1000) - latestOnChainTimestamp;
    const isStale = ageSeconds > thresholdSeconds;
    if (isStale) {
      await this.emitAlert({
        timestamp: Math.floor(Date.now() / 1000),
        asset,
        type: 'stale',
        message: `On-chain price heartbeat stale for ${asset}: ${ageSeconds}s since last on-chain update (threshold: ${thresholdSeconds}s). Runbook: docs/runbooks/price-feed-stale.md`,
        elapsedSeconds: ageSeconds,
        thresholdSeconds,
      });
    }
    return isStale;
  }

  /**
   * Detects disagreement between live oracle sources for the same asset,
   * independent of the temporal deviation check in checkPrice().
   */
  async checkSourceDisagreement(
    asset: string,
    sourcePrices: { source: string; price: string }[],
  ): Promise<void> {
    const threshold = this.config.sourceDisagreementThresholdPercent ?? 5;
    if (sourcePrices.length < 2) return;

    const values = sourcePrices.map((s) => parseFloat(s.price)).filter((v) => Number.isFinite(v));
    if (values.length < 2) return;

    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min <= 0) return;

    const deviationPercent = ((max - min) / min) * 100;
    if (deviationPercent > threshold) {
      await this.emitAlert({
        timestamp: Math.floor(Date.now() / 1000),
        asset: asset.toUpperCase(),
        type: 'deviation',
        message: `Oracle source disagreement for ${asset.toUpperCase()}: ${deviationPercent.toFixed(2)}% spread across sources`,
        deviationPercent,
        affectedSources: sourcePrices.map((s) => s.source),
      });
    }
  }

  private async emitAlert(alert: AlertEvent): Promise<boolean> {
    const dedupKey = this.getAlertKey(alert);
    const now = Math.floor(Date.now() / 1000);
    const dedupWindowSeconds = this.config.dedupWindowSeconds ?? 300;
    const lastAlertAt = this.lastAlertAtByKey.get(dedupKey);

    if (lastAlertAt && now - lastAlertAt < dedupWindowSeconds) {
      logger.debug(`Suppressing duplicate alert for ${dedupKey} within ${dedupWindowSeconds}s dedup window`);
      return false;
    }

    if (this.isFlapping(dedupKey, now)) {
      logger.warn(`Suppressing flapping alert for ${dedupKey} within the suppression window`);
      return false;
    }

    this.lastAlertAtByKey.set(dedupKey, now);
    this.recordAlertTrigger(dedupKey, now);
    this.alertHistory.push(alert);

    const escalation = resolveEscalationRoute({
      type: alert.type,
      asset: alert.asset,
      message: alert.message,
    });

    if (this.config.enableConsoleLog) {
      this.logToConsole({
        ...alert,
        message: `${alert.message} | escalation=${escalation.severity}/${escalation.primaryChannel}/${escalation.primaryTarget}`,
      });
    }

    if (this.config.enableFileLog && this.config.alertHistoryPath) {
      this.logToFile({
        ...alert,
        message: `${alert.message} | escalation=${escalation.severity}/${escalation.primaryChannel}/${escalation.primaryTarget}`,
      });
    }

    const wss = WebSocketServer.getInstance();
    if (wss) {
      wss.broadcastAlert(alert);
    }

    if (this.config.webhookUrl) {
      await this.sendWebhook(alert);
    }

    if (this.config.slackWebhookUrl) {
      await this.sendSlack(alert);
    }

    if (this.config.pagerDutyRoutingKey) {
      await this.sendPagerDuty(alert);
    }

    if (this.config.opsGenieApiKey) {
      await this.sendOpsgenie(alert);
    }

    if (this.config.emailWebhookUrl) {
      await this.sendEmail(alert);
    }

    return true;
  }

  private getAlertKey(alert: AlertEvent): string {
    const target = alert.source ?? alert.affectedSources?.join(',') ?? 'global';
    return `${alert.asset.toUpperCase()}:${alert.type}:${target}`;
  }

  private isFlapping(alertKey: string, now: number): boolean {
    const suppressionWindow = this.config.flapSuppressionWindowSeconds ?? 1800;
    const maxTriggers = this.config.flapMaxTriggers ?? 3;
    const history = this.alertTriggerHistory.get(alertKey) || [];
    const recent = history.filter((ts) => now - ts <= suppressionWindow);

    if (recent.length >= maxTriggers) {
      return true;
    }

    return false;
  }

  private recordAlertTrigger(alertKey: string, now: number): void {
    const history = this.alertTriggerHistory.get(alertKey) || [];
    const trimmed = history.filter((ts) => now - ts <= (this.config.flapSuppressionWindowSeconds ?? 1800));
    trimmed.push(now);
    this.alertTriggerHistory.set(alertKey, trimmed);
  }

  private async sendSlack(alert: AlertEvent): Promise<void> {
    try {
      const response = await fetch(this.config.slackWebhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `:rotating_light: *${alert.type.toUpperCase()}* — ${alert.message}`,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      logger.error('Failed to deliver Slack alert:', (error as Error).message);
    }
  }

  private async sendPagerDuty(alert: AlertEvent): Promise<void> {
    try {
      const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key: this.config.pagerDutyRoutingKey,
          event_action: 'trigger',
          dedup_key: `${alert.asset}:${alert.type}`,
          payload: {
            summary: alert.message,
            source: 'price-oracle-aggregator',
            severity: (alert.type === 'source_down' || alert.type === 'sla_breach') ? 'critical' : 'warning',
            custom_details: alert,
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      logger.error('Failed to deliver PagerDuty alert:', (error as Error).message);
    }
  }

  private async sendOpsgenie(alert: AlertEvent): Promise<void> {
    try {
      const priority = alert.type === 'source_down' || alert.type === 'sla_breach' ? 'P1' : 'P3';
      const response = await fetch('https://api.opsgenie.com/v2/alerts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `GenieKey ${this.config.opsGenieApiKey}`,
        },
        body: JSON.stringify({
          message: alert.message,
          description: `${alert.asset}: ${alert.type} alert triggered. Runbook: docs/runbooks/README.md`,
          alias: `${alert.asset}:${alert.type}`,
          priority,
          tags: ['price-oracle', alert.asset, alert.type],
          details: {
            asset: alert.asset,
            type: alert.type,
            summary: alert.message,
            timestamp: alert.timestamp,
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      logger.error('Failed to deliver Opsgenie alert:', (error as Error).message);
    }
  }

  private async sendEmail(alert: AlertEvent): Promise<void> {
    try {
      const response = await fetch(this.config.emailWebhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: this.config.emailRecipients || [],
          subject: `[Price Oracle Alert] ${alert.type} for ${alert.asset}`,
          text: alert.message,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      logger.error('Failed to deliver email alert:', (error as Error).message);
    }
  }

  private logToConsole(alert: AlertEvent): void {
    logger.warn(`[ALERT] ${alert.message}`, {
      type: alert.type,
      asset: alert.asset,
    });
  }

  private logToFile(alert: AlertEvent): void {
    try {
      const line = JSON.stringify(alert) + '\n';
      fs.appendFileSync(this.config.alertHistoryPath!, line, 'utf-8');
    } catch (error) {
      logger.error('Failed to write alert to file:', error);
    }
  }

  private async sendWebhook(alert: AlertEvent): Promise<void> {
    if (!this.config.webhookUrl) return;

    const maxRetries = this.config.webhookRetries || 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'stellar-price-oracle-alertmanager/1.0',
          },
          body: JSON.stringify(alert),
        });

        if (response.ok) {
          logger.info(`Webhook delivered for ${alert.asset} (${alert.type})`);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (error) {
        lastError = error as Error;
        const delayMs = (this.config.webhookRetryDelayMs || 1000) * Math.pow(2, attempt);
        if (attempt < maxRetries - 1) {
          logger.debug(`Webhook retry ${attempt + 1}/${maxRetries} for ${alert.asset} after ${delayMs}ms`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    if (lastError) {
      logger.error(`Failed to deliver webhook after ${maxRetries} attempts:`, lastError.message);
    }
  }

  getAlertHistory(limit = 100): AlertEvent[] {
    return this.alertHistory.slice(-limit);
  }

  clearAlertHistory(): void {
    this.alertHistory = [];
  }
}

export default AlertManager;
