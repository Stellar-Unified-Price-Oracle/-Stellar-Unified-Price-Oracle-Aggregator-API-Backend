import crypto, { randomUUID } from 'crypto';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';
import { getVaultClient } from '@stellar-oracle/vault-client';

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
  verificationKey: string;
  active: boolean;
  status: 'healthy' | 'degraded' | 'dead-letter';
  createdAt: number;
  lastTriggeredAt?: number;
  lastPrice?: number;
  lastFailure?: string;
  failureCount: number;
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

export function signWebhookPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  if (!secret || !body || !signature) return false;

  const normalized = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const expected = signWebhookPayload(secret, body);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(normalized, 'hex');

  if (expectedBuf.length !== actualBuf.length) return false;

  try {
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
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
    const secret = randomUUID();
    const verificationKey = crypto.createHash('sha256').update(secret).digest('hex');
    const webhook: WebhookRegistration = {
      id: randomUUID(),
      url,
      apiKeyPrefix,
      trigger,
      secret,
      verificationKey,
      active: true,
      status: 'healthy',
      createdAt: Date.now(),
      failureCount: 0,
    };
    this.webhooks.set(webhook.id, webhook);

    // Persist webhook secret to Vault asynchronously
    this.persistWebhookToVault(webhook).catch((err) => {
      logger.warn(`Failed to persist webhook ${webhook.id} to Vault`, err);
    });

    return webhook;
  }

  private async persistWebhookToVault(webhook: WebhookRegistration): Promise<void> {
    try {
      const vault = getVaultClient();
      if (!vault.isInitialized()) return;
      await vault.saveWebhookSecret(webhook.apiKeyPrefix, {
        webhookId: webhook.id,
        secret: webhook.secret,
        verificationKey: webhook.verificationKey,
        apiKeyPrefix: webhook.apiKeyPrefix,
        createdAt: webhook.createdAt,
      });
    } catch {
      // Vault persistence is best-effort for webhooks
    }
  }

  list(apiKeyPrefix?: string): WebhookRegistration[] {
    const all = Array.from(this.webhooks.values());
    return apiKeyPrefix ? all.filter((w) => w.apiKeyPrefix === apiKeyPrefix) : all;
  }

  get(id: string): WebhookRegistration | undefined {
    return this.webhooks.get(id);
  }

  remove(id: string): boolean {
    const webhook = this.webhooks.get(id);
    const deleted = this.webhooks.delete(id);
    if (deleted && webhook) {
      this.removeWebhookFromVault(webhook).catch((err) => {
        logger.warn(`Failed to remove webhook ${id} from Vault`, err);
      });
    }
    return deleted;
  }

  private async removeWebhookFromVault(webhook: WebhookRegistration): Promise<void> {
    try {
      const vault = getVaultClient();
      if (!vault.isInitialized()) return;
      await vault.deleteWebhookSecret(webhook.apiKeyPrefix, webhook.id);
    } catch {
      // Vault cleanup is best-effort
    }
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
   * Clears all registrations and delivery history. Used by tests for isolation
   * and available for operators who need to wipe in-memory webhook state.
   */
  reset(): void {
    this.webhooks.clear();
    this.deliveryLog = [];
  }

  /**
   * Delivers a payload with exponential backoff retry. Failures are logged
   * but never throw, since this runs from background price-update fan-out.
   */
  async deliver(webhook: WebhookRegistration, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ webhookId: webhook.id, ...payload });
    const signature = signWebhookPayload(webhook.secret, body);
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
            'X-Webhook-Signature': `sha256=${signature}`,
            'X-Webhook-Timestamp': String(Math.floor(Date.now() / 1000)),
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const entry = {
          id: randomUUID(),
          webhookId: webhook.id,
          url: webhook.url,
          attempt,
          success: res.ok,
          statusCode: res.status,
          timestamp: Date.now(),
        };
        this.logDelivery(entry);

        if (res.ok) {
          webhook.status = 'healthy';
          webhook.failureCount = 0;
          webhook.lastFailure = undefined;
          return;
        }

        webhook.lastFailure = `HTTP ${res.status}`;
        webhook.status = 'degraded';
        webhook.failureCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        webhook.lastFailure = message;
        webhook.status = 'degraded';
        webhook.failureCount += 1;
        this.logDelivery({
          id: randomUUID(),
          webhookId: webhook.id,
          url: webhook.url,
          attempt,
          success: false,
          error: message,
          timestamp: Date.now(),
        });
      }

      if (attempt < config.webhooks.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
      }
    }

    webhook.status = 'dead-letter';
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
