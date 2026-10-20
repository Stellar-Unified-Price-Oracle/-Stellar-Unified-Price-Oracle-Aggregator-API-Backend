import crypto, { randomUUID } from 'crypto';
import { validateOutboundUrl } from '@stellar-oracle/ssrf-guard';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';
import { getVaultClient } from '@stellar-oracle/vault-client';
import {
  webhookCircuitsOpen,
  webhookDeliveriesInFlight,
  webhookDeliveriesTotal,
  webhookJobsDroppedTotal,
  webhookQueueDepth,
} from '../observability/metrics';

export type WebhookTriggerType = 'threshold' | 'interval';

export type WebhookCircuitState = 'closed' | 'open' | 'half-open';

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
  /** Per-registration HMAC secret. Returned exactly once, in the registration response. */
  secret: string;
  active: boolean;
  status: 'healthy' | 'degraded' | 'dead-letter';
  circuit: WebhookCircuitState;
  nextProbeAt?: number;
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

interface DeliveryJob {
  webhookId: string;
  payload: Record<string, unknown>;
  attempt: number;
  done: Promise<void>;
  resolve: () => void;
}

interface DestinationQueue {
  webhookId: string;
  pending: DeliveryJob[];
  running: boolean;
  timer?: NodeJS.Timeout;
  timerKind?: 'retry' | 'probe';
  consecutiveFailures: number;
}

function backoffDelayMs(attempt: number): number {
  const delay = config.webhooks.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(delay, config.webhooks.maxDelayMs);
}

export const WEBHOOK_SIGNATURE_ALGORITHM = 'HMAC-SHA256';
export const WEBHOOK_SIGNATURE_HEADER = 'X-Webhook-Signature';
export const WEBHOOK_SIGNATURE_FORMAT = 'sha256=<lowercase hex>';

export function signWebhookPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * The exact bytes that get signed and sent: JSON.stringify inserts no spaces,
 * and the signature covers those bytes, so verification must hash the raw
 * request body rather than a re-serialised object.
 */
export function buildWebhookBody(webhookId: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ webhookId, ...payload });
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

/**
 * Delivery runs through an in-process queue (consistent with webhook
 * registrations, which are in-memory): per-destination FIFO with at most one
 * job in flight per destination, a global bound of WEBHOOK_MAX_CONCURRENT
 * concurrent deliveries, queue- scheduled retries with exponential backoff,
 * and a per-destination circuit breaker that parks persistently failing
 * endpoints until a cool-down probe succeeds. The broadcast path only
 * enqueues — it never waits for a fetch, a backoff timer, or a queue slot.
 */
class WebhookService {
  private webhooks = new Map<string, WebhookRegistration>();
  private deliveryLog: WebhookDeliveryLog[] = [];
  private readonly maxLogEntries = 2000;
  private dests = new Map<string, DestinationQueue>();
  private inFlight = 0;

  register(
    url: string,
    apiKeyPrefix: string,
    trigger: WebhookTrigger,
  ): WebhookRegistration {
    const secret = crypto.randomBytes(32).toString('hex');
    const webhook: WebhookRegistration = {
      id: randomUUID(),
      url,
      apiKeyPrefix,
      trigger,
      secret,
      active: true,
      status: 'healthy',
      circuit: 'closed',
      createdAt: Date.now(),
      failureCount: 0,
    };
    this.webhooks.set(webhook.id, webhook);
    this.persist(webhook);

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
      this.dropDestination(id);
      this.refreshCircuitGauge();
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

  /**
   * Durable, per-webhook delivery history. Reads go to the shared store so a
   * consumer sees the full retention window, not a process-local ring; the
   * ring is only a fallback when the store is unreachable.
   */
  async deliveries(webhookId?: string, query: Omit<DeliveryQuery, 'webhookId'> = {}): Promise<WebhookDeliveryLog[]> {
    try {
      return await this.store.listDeliveries({ ...query, webhookId });
    } catch (err) {
      logger.warn('Webhook delivery store unreachable; serving in-memory history', err);
      const ring = webhookId
        ? this.deliveryRing.filter((d) => d.webhookId === webhookId)
        : [...this.deliveryRing];
      const since = query.since;
      const filtered = since === undefined ? ring : ring.filter((d) => d.timestamp >= since);
      const limit = query.limit;
      if (limit !== undefined && filtered.length > limit) {
        return filtered.slice(filtered.length - limit);
      }
      return filtered;
    }
  }

  async listDeadLetters(apiKeyPrefix?: string): Promise<DeadLetterEntry[]> {
    try {
      return await this.store.listDeadLetters(apiKeyPrefix);
    } catch (err) {
      logger.warn('Webhook dead-letter store unreachable', err);
      return [];
    }
  }

  async getDeadLetter(id: string): Promise<DeadLetterEntry | undefined> {
    try {
      return await this.store.getDeadLetter(id);
    } catch (err) {
      logger.warn('Webhook dead-letter store unreachable', err);
      return undefined;
    }
  }

  /**
   * Clears all registrations, queued jobs, and delivery history. Used by tests
   * for isolation and available for operators who need to wipe webhook state.
   */
  reset(): void {
    for (const dest of this.dests.values()) {
      if (dest.timer) clearTimeout(dest.timer);
      dest.pending.forEach((job) => job.resolve());
    }
    this.dests.clear();
    this.webhooks.clear();
    this.deliveryLog = [];
    this.inFlight = 0;
    webhookQueueDepth.set(0);
    webhookDeliveriesInFlight.set(0);
    webhookCircuitsOpen.set(0);
  }

  private dropDestination(webhookId: string): void {
    const dest = this.dests.get(webhookId);
    if (!dest) return;
    if (dest.timer) clearTimeout(dest.timer);
    dest.pending.forEach((job) => job.resolve());
    this.dests.delete(webhookId);
    webhookQueueDepth.set(this.totalPending());
  }

  private totalPending(): number {
    let total = 0;
    for (const dest of this.dests.values()) total += dest.pending.length;
    return total;
  }

  private refreshCircuitGauge(): void {
    let open = 0;
    for (const webhook of this.webhooks.values()) if (webhook.circuit === 'open') open += 1;
    webhookCircuitsOpen.set(open);
  }

  private makeJob(webhook: WebhookRegistration, payload: Record<string, unknown>): DeliveryJob {
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    return { webhookId: webhook.id, payload, attempt: 0, done, resolve };
  }

  private enqueue(webhook: WebhookRegistration, payload: Record<string, unknown>): DeliveryJob {
    const dest = this.destination(webhook.id);
    if (dest.pending.length >= config.webhooks.maxPendingPerDestination) {
      const dropped = dest.pending.shift();
      dropped?.resolve();
      webhookJobsDroppedTotal.inc({ reason: 'destination_backlog' });
      logger.warn(`Webhook ${webhook.id} backlog full; dropped oldest queued delivery`);
    }
    const job = this.makeJob(webhook, payload);
    dest.pending.push(job);
    webhookQueueDepth.set(this.totalPending());
    this.schedule(dest);
    return job;
  }

  private setTimer(dest: DestinationQueue, delayMs: number, kind: 'retry' | 'probe'): void {
    dest.timerKind = kind;
    dest.timer = setTimeout(() => {
      dest.timer = undefined;
      dest.timerKind = undefined;
      if (kind === 'probe') {
        const webhook = this.webhooks.get(dest.webhookId);
        if (webhook && webhook.circuit === 'open') webhook.circuit = 'half-open';
      }
      this.pump();
    }, delayMs);
    dest.timer.unref?.();
  }

  private schedule(dest: DestinationQueue): void {
    if (!dest.timer) {
      const webhook = this.webhooks.get(dest.webhookId);
      if (webhook && webhook.circuit === 'open' && dest.pending.length > 0) {
        const wait = Math.max(0, (webhook.nextProbeAt ?? Date.now()) - Date.now());
        this.setTimer(dest, wait, 'probe');
      }
    }
    this.pump();
  }

  private nextReady(): DestinationQueue | undefined {
    for (const dest of this.dests.values()) {
      if (dest.running || dest.timer || dest.pending.length === 0) continue;
      const webhook = this.webhooks.get(dest.webhookId);
      if (!webhook || webhook.circuit === 'open') continue;
      return dest;
    }
    return undefined;
  }

  private pump(): void {
    const max = Math.max(1, config.webhooks.maxConcurrent);
    while (this.inFlight < max) {
      const dest = this.nextReady();
      if (!dest) return;
      void this.runJob(dest);
    }
  }

  private async runJob(dest: DestinationQueue): Promise<void> {
    const job = dest.pending[0];
    const webhook = this.webhooks.get(dest.webhookId);
    if (!job || !webhook) {
      dest.running = false;
      return;
    }
    dest.running = true;
    this.inFlight += 1;
    webhookDeliveriesInFlight.set(this.inFlight);

    const attempt = job.attempt + 1;
    job.attempt = attempt;
    const ok = await this.attemptOnce(webhook, job, attempt);

    let retryDelayMs: number | undefined;
    if (ok) {
      dest.pending.shift();
      dest.consecutiveFailures = 0;
      webhook.circuit = 'closed';
      webhook.nextProbeAt = undefined;
      this.refreshCircuitGauge();
      webhookDeliveriesTotal.inc({ result: 'success' });
      job.resolve();
    } else if (attempt < config.webhooks.maxRetries) {
      retryDelayMs = backoffDelayMs(attempt);
      webhookDeliveriesTotal.inc({ result: 'retry_scheduled' });
    } else {
      dest.pending.shift();
      webhook.status = 'dead-letter';
      dest.consecutiveFailures += 1;
      webhookDeliveriesTotal.inc({ result: 'failed' });
      job.resolve();
      if (dest.consecutiveFailures >= config.webhooks.circuitFailureThreshold && webhook.circuit !== 'open') {
        webhook.circuit = 'open';
        webhook.nextProbeAt = Date.now() + config.webhooks.circuitCooldownMs;
        this.refreshCircuitGauge();
        logger.warn(
          `Webhook ${webhook.id} circuit opened after ${dest.consecutiveFailures} consecutive failed deliveries`,
        );
      }
    }

    dest.running = false;
    this.inFlight -= 1;
    webhookDeliveriesInFlight.set(this.inFlight);
    webhookQueueDepth.set(this.totalPending());

    if (retryDelayMs !== undefined) {
      this.setTimer(dest, retryDelayMs, 'retry');
      this.pump();
    } else {
      this.schedule(dest);
    }
  }

  private async attemptOnce(
    webhook: WebhookRegistration,
    job: DeliveryJob,
    attempt: number,
  ): Promise<boolean> {
    const body = JSON.stringify({ webhookId: webhook.id, ...job.payload });
    const signature = signWebhookPayload(webhook.secret, body);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.webhooks.timeoutMs);
      try {
        const res = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Id': webhook.id,
            [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signature}`,
            'X-Webhook-Timestamp': String(Math.floor(Date.now() / 1000)),
          },
          body,
          signal: controller.signal,
          // Never follow. A 302 to an internal address would otherwise be
          // fetched by undici without ever passing the connect-time lookup,
          // which is the whole escape route this issue describes.
          redirect: 'manual',
          dispatcher: getWebhookDispatcher(),
        });

        this.logDelivery({
          id: randomUUID(),
          webhookId: webhook.id,
          url: webhook.url,
          attempt,
          success: res.ok,
          statusCode: res.status,
          timestamp: Date.now(),
        });

        if (res.ok) {
          webhook.status = 'healthy';
          webhook.failureCount = 0;
          webhook.lastFailure = undefined;
          return true;
        }

        webhook.lastFailure =
          res.status >= 300 && res.status < 400 ? 'redirect-not-followed' : `HTTP ${res.status}`;
        webhook.status = 'degraded';
        webhook.failureCount += 1;
        return false;
      } finally {
        clearTimeout(timeout);
      }
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
      return false;
    }
  }

  /**
   * Enqueues one delivery and resolves when this specific job has settled
   * (delivered, exhausted its retries, or been dropped). Retries are scheduled
   * by the queue, never awaited in a request-scoped loop.
   */
  async deliver(webhook: WebhookRegistration, payload: Record<string, unknown>): Promise<void> {
    const job = this.enqueue(webhook, payload);
    await job.done;
  }

  /**
   * Called on every price update; fires threshold-triggered webhooks whose
   * percent-change condition is met, and interval-triggered webhooks whose
   * minimum delivery interval has elapsed. Returns as soon as matching jobs
   * are enqueued — delivery never blocks the fan-out path.
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
      this.enqueue(webhook, { asset, price, timestamp: Math.floor(now / 1000) });
    }
  }

  /**
   * Waits until every queued job has settled or is parked behind an open
   * circuit cool-down. Intended for tests and operator tooling.
   */
  async drain(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (this.totalPending() > 0 || this.inFlight > 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`webhook queue drain timed out after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export { WebhookService };
export const webhookService = new WebhookService();
