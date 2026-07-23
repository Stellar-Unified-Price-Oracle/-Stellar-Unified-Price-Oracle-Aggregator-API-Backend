import { randomUUID } from 'crypto';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';

export type WebhookTriggerType = 'threshold' | 'interval';

export interface WebhookTrigger {
  type: WebhookTriggerType;
  asset: string;
  // threshold: percent change that fires delivery; interval: ms between deliveries.
  value: number;
}

export interface WebhookRegistration {
  id: string;
  url: string;
  apiKeyPrefix: string;
  trigger: WebhookTrigger;
  secret: string;
  active: boolean;
  createdAt: number;
  lastTriggeredAt?: number;
  lastPrice?: number;
}

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  url: string;
  attempt: number;
  success: boolean;
  statusCode?: number;
  error?: string;
  timestamp: number;
}

function backoffDelayMs(attempt: number): number {
  const delay = config.webhooks.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(delay, config.webhooks.maxDelayMs);
}

class WebhookService {
  private webhooks = new Map<string, WebhookRegistration>();
  private deliveryLog: WebhookDeliveryLog[] = [];
  private readonly maxLogEntries = 2000;

  register(
    url: string,
    apiKeyPrefix: string,
    trigger: WebhookTrigger,
  ): WebhookRegistration {
    const webhook: WebhookRegistration = {
      id: randomUUID(),
      url,
      apiKeyPrefix,
      trigger,
      secret: randomUUID(),
      active: true,
      createdAt: Date.now(),
    };
    this.webhooks.set(webhook.id, webhook);
    return webhook;
  }

  list(apiKeyPrefix?: string): WebhookRegistration[] {
    const all = Array.from(this.webhooks.values());
    return apiKeyPrefix ? all.filter((w) => w.apiKeyPrefix === apiKeyPrefix) : all;
  }

  get(id: string): WebhookRegistration | undefined {
    return this.webhooks.get(id);
  }

  remove(id: string): boolean {
    return this.webhooks.delete(id);
  }

  deliveries(webhookId?: string): WebhookDeliveryLog[] {
    return webhookId
      ? this.deliveryLog.filter((d) => d.webhookId === webhookId)
      : this.deliveryLog;
  }

  private logDelivery(entry: WebhookDeliveryLog): void {
    this.deliveryLog.push(entry);
    if (this.deliveryLog.length > this.maxLogEntries) this.deliveryLog.shift();
  }

  /**
   * Delivers a payload with exponential backoff retry. Failures are logged
   * but never throw, since this runs from background price-update fan-out.
   */
  async deliver(webhook: WebhookRegistration, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ webhookId: webhook.id, ...payload });
    let attempt = 0;

    while (attempt < config.webhooks.maxRetries) {
      attempt += 1;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.webhooks.timeoutMs);
        const res = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Id': webhook.id,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        this.logDelivery({
          id: randomUUID(),
          webhookId: webhook.id,
          url: webhook.url,
          attempt,
          success: res.ok,
          statusCode: res.status,
          timestamp: Date.now(),
        });

        if (res.ok) return;
      } catch (err) {
        this.logDelivery({
          id: randomUUID(),
          webhookId: webhook.id,
          url: webhook.url,
          attempt,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
      }

      if (attempt < config.webhooks.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
      }
    }

    logger.warn(`Webhook ${webhook.id} failed after ${attempt} attempts`);
  }

  /**
   * Called on every price update; fires threshold-triggered webhooks whose
   * percent-change condition is met, and interval-triggered webhooks whose
   * minimum delivery interval has elapsed.
   */
  async handlePriceUpdate(asset: string, price: number): Promise<void> {
    const now = Date.now();
    for (const webhook of this.webhooks.values()) {
      if (!webhook.active || webhook.trigger.asset !== asset) continue;

      if (webhook.trigger.type === 'threshold') {
        const prev = webhook.lastPrice;
        webhook.lastPrice = price;
        if (prev === undefined) continue;
        const pctChange = Math.abs((price - prev) / prev) * 100;
        if (pctChange < webhook.trigger.value) continue;
      } else {
        const minInterval = Math.max(webhook.trigger.value, config.webhooks.minIntervalMs);
        if (webhook.lastTriggeredAt && now - webhook.lastTriggeredAt < minInterval) continue;
      }

      webhook.lastTriggeredAt = now;
      void this.deliver(webhook, { asset, price, timestamp: Math.floor(now / 1000) });
    }
  }
}

export const webhookService = new WebhookService();
