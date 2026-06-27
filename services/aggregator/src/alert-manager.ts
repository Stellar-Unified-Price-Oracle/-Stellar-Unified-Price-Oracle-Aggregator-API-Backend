import fs from 'fs';
import path from 'path';
import { AggregatedPrice } from './types';
import { logger } from './utils/logger';

export interface AlertThresholds {
  asset: string;
  deviationThresholdPercent: number;
  staleThresholdSeconds: number;
  sourceDownThreshold: number;
}

export interface AlertEvent {
  timestamp: number;
  asset: string;
  type: 'deviation' | 'stale' | 'source_down';
  message: string;
  previousPrice?: string;
  currentPrice?: string;
  deviationPercent?: number;
  affectedSources?: string[];
}

export interface AlertConfig {
  webhookUrl?: string;
  webhookRetries?: number;
  webhookRetryDelayMs?: number;
  enableConsoleLog?: boolean;
  enableFileLog?: boolean;
  alertHistoryPath?: string;
}

class AlertManager {
  private thresholds: Map<string, AlertThresholds> = new Map();
  private priceHistory: Map<string, AggregatedPrice> = new Map();
  private sourceFailureCount: Map<string, number> = new Map();
  private config: AlertConfig;
  private alertHistory: AlertEvent[] = [];
  private static readonly DEFAULT_CONFIG: AlertConfig = {
    webhookRetries: 3,
    webhookRetryDelayMs: 1000,
    enableConsoleLog: true,
    enableFileLog: true,
    alertHistoryPath: path.resolve(__dirname, '../../data/alerts.jsonl'),
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

  private async emitAlert(alert: AlertEvent): Promise<void> {
    this.alertHistory.push(alert);

    if (this.config.enableConsoleLog) {
      this.logToConsole(alert);
    }

    if (this.config.enableFileLog && this.config.alertHistoryPath) {
      this.logToFile(alert);
    }

    if (this.config.webhookUrl) {
      await this.sendWebhook(alert);
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
