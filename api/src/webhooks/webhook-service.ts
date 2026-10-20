import crypto, { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';
import { getVaultClient } from '@stellar-oracle/vault-client';
import { validateOutboundUrl } from '@stellar-oracle/ssrf-guard';
import { getWebhookDispatcher, webhookSsrfPolicy } from './ssrf';
import { FileWebhookStore } from './file-webhook-store';
import { RedisWebhookStore } from './redis-webhook-store';
import {
  webhookPropagationMs,
  type DeadLetterEntry,
  type DeliveryQuery,
  type WebhookStore,
} from './webhook-store';
import {
  webhookCircuitsOpen,
  webhookDeliveriesInFlight,
  webhookDeliveriesTotal,
  webhookJobsDroppedTotal,
  webhookQueueDepth,
} from '../observability/metrics';

export type { DeadLetterEntry, DeliveryQuery } from './webhook-store';

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
  /** Hash of the secret stored with the registration; never leaves the service. */
  verificationKey: string;
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

export type ReplayStatus = 'replayed' | 'duplicate' | 'missing' | 'failed' | 'in-flight';

export interface ReplayResult {
  status: ReplayStatus;
  entry?: DeadLetterEntry;
  failure?: string;
}

interface DeliveryJob {
  webhookId: string;
  payload: Record<string, unknown>;
  attempt: number;
  succeeded: boolean;
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

function createWebhookStore(): WebhookStore {
  if (config.redisUrl) {
    return new RedisWebhookStore(
      new Redis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      }),
    );
  }
  return new FileWebhookStore();
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
 * Delivery runs through an in-process queue with per-destination FIFO ordering,
 * a global bound on concurrent deliveries, queued retries with exponential
 * backoff, and a per-destination circuit breaker that parks persistently
 * failing endpoints until a cool-down probe succeeds. The broadcast path only
 * enqueues — it never waits for a fetch, a backoff timer, or a queue slot.
 *
 * Registrations, delivery history and dead letters live in a shared
 * `WebhookStore` (Redis when `REDIS_URL` is set, otherwise files under
 * `WEBHOOK_DATA_DIR`). Each replica keeps a local mirror for synchronous
 * lookups and writes through to the store, so the propagation window for a
 * registration change seen by another replica is `WEBHOOK_PROPAGATION_MS`.
 */
class WebhookService {
  private webhooks = new Map<string, WebhookRegistration>();
  private deliveryRing: WebhookDeliveryLog[] = [];
  private readonly maxRingEntries = 2000;
  private dests = new Map<string, DestinationQueue>();
  private inFlight = 0;
  private pendingWrites: Promise<unknown>[] = [];
  private replaying = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private storeWarned = false;
  private store: WebhookStore;

  constructor(store: WebhookStore = createWebhookStore()) {
    this.store = store;
  }

  /**
   * Reads registrations from the shared store into the local mirror. Called at
   * startup and after a simulated restart; a failed read leaves the mirror
   * untouched rather than dropping registrations.
   */
  async load(): Promise<void> {
    await this.flush();
    try {
      await this.store.init();
      const records = await this.store.listRegistrations();
      this.mergeIntoMirror(records);
      await this.store.prune();
      this.storeWarned = false;
      logger.info(`Loaded ${records.length} webhook registrations from the shared store`);
    } catch (err) {
      logger.warn('Webhook store unavailable at startup; registrations start empty', err);
    }
  }

  /**
   * Re-reads registrations on an interval so registration and removal converge
   * across replicas. Runtime-only fields are kept from the mirror so a refresh
   * never resets delivery pacing or an open circuit.
   */
  startRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refreshFromStore();
    }, webhookPropagationMs());
    this.refreshTimer.unref?.();
  }

  stopRefresh(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async refreshFromStore(): Promise<void> {
    try {
      await this.flush();
      const records = await this.store.listRegistrations();
      this.mergeIntoMirror(records);
      this.storeWarned = false;
    } catch (err) {
      if (!this.storeWarned) {
        this.storeWarned = true;
        logger.warn('Webhook store unreachable; registrations are not converging across replicas', err);
      }
    }
  }

  private mergeIntoMirror(records: Awaited<ReturnType<WebhookStore['listRegistrations']>>): void {
    const next = new Map<string, WebhookRegistration>();
    for (const record of records) {
      const existing = this.webhooks.get(record.id);
      next.set(record.id, {
        ...record,
        verificationKey: record.verificationKey,
        circuit: existing?.circuit ?? 'closed',
        nextProbeAt: existing?.nextProbeAt,
        status: existing?.status ?? record.status,
        failureCount: existing?.failureCount ?? record.failureCount,
        lastFailure: existing?.lastFailure ?? record.lastFailure,
        lastPrice: existing?.lastPrice ?? record.lastPrice,
        lastTriggeredAt: existing?.lastTriggeredAt ?? record.lastTriggeredAt,
      });
    }
    this.webhooks = next;
  }

  /**
   * Awaits every store write that is still in flight, so a subsequent `load()`
   * observes them. Exposed for tests and for graceful shutdown.
   */
  async flush(): Promise<void> {
    while (this.pendingWrites.length > 0) {
      const batch = this.pendingWrites;
      this.pendingWrites = [];
      await Promise.all(batch);
    }
  }

  private persist(registration: WebhookRegistration): void {
    const write = this.store.saveRegistration(registration).catch((err: unknown) => {
      logger.warn(`Failed to persist webhook ${registration.id} to the shared store`, err);
    });
    this.pendingWrites.push(write);
  }

  register(
    url: string,
    apiKeyPrefix: string,
    trigger: WebhookTrigger,
  ): WebhookRegistration {
    validateOutboundUrl(url, webhookSsrfPolicy(apiKeyPrefix));
    const secret = crypto.randomBytes(32).toString('hex');
    const webhook: WebhookRegistration = {
      id: randomUUID(),
      url,
      apiKeyPrefix,
      trigger,
      secret,
      verificationKey: crypto.createHash('sha256').update(secret).digest('hex'),
      active: true,
      status: 'healthy',
      circuit: 'closed',
      createdAt: Date.now(),
      failureCount: 0,
    };
    this.webhooks.set(webhook.id, webhook);
    this.persist(webhook);

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
      const write = this.store.deleteRegistration(id).catch((err: unknown) => {
        logger.warn(`Failed to remove webhook ${id} from the shared store`, err);
      });
      this.pendingWrites.push(write);
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
   * Replays a dead-lettered payload exactly once. A successful replay resolves
   * the entry, so any later replay of the same entry — with any idempotency
   * key — returns `duplicate` without delivering again.
   */
  async replay(deadLetterId: string, idempotencyKey: string): Promise<ReplayResult> {
    const entry = await this.getDeadLetter(deadLetterId);
    if (!entry) return { status: 'missing' };
    if (entry.resolvedAt) return { status: 'duplicate', entry };
    if (this.replaying.has(deadLetterId)) return { status: 'in-flight', entry };

    const webhook = this.webhooks.get(entry.webhookId);
    if (!webhook) {
      return { status: 'failed', failure: 'Webhook is no longer registered', entry };
    }

    this.replaying.add(deadLetterId);
    try {
      const job = this.enqueue(webhook, entry.payload);
      await job.done;
      if (!job.succeeded) {
        return { status: 'failed', failure: webhook.lastFailure || 'Delivery failed', entry };
      }
      const resolved: DeadLetterEntry = {
        ...entry,
        resolvedAt: Date.now(),
        replayId: idempotencyKey,
      };
      await this.store.updateDeadLetter(resolved);
      return { status: 'replayed', entry: resolved };
    } catch (err) {
      return { status: 'failed', failure: err instanceof Error ? err.message : String(err), entry };
    } finally {
      this.replaying.delete(deadLetterId);
    }
  }

  private async logDelivery(entry: WebhookDeliveryLog): Promise<void> {
    this.deliveryRing.push(entry);
    if (this.deliveryRing.length > this.maxRingEntries) this.deliveryRing.shift();
    const write = this.store.appendDelivery(entry).catch((err: unknown) => {
      logger.warn(`Failed to persist delivery ${entry.id} to the shared store`, err);
    });
    this.pendingWrites.push(write);
  }

  /**
   * Clears all registrations, queued jobs, delivery history and durable
   * webhook state. Used by tests for isolation and by operators who need to
   * wipe webhook state.
   */
  async reset(): Promise<void> {
    for (const dest of this.dests.values()) {
      if (dest.timer) clearTimeout(dest.timer);
      dest.pending.forEach((job) => job.resolve());
    }
    this.dests.clear();
    this.webhooks.clear();
    this.deliveryRing = [];
    this.replaying.clear();
    this.inFlight = 0;
    webhookQueueDepth.set(0);
    webhookDeliveriesInFlight.set(0);
    webhookCircuitsOpen.set(0);
    try {
      await this.store.clear();
    } catch (err) {
      logger.warn('Failed to clear the webhook store', err);
    }
  }

  private dropDestination(webhookId: string): void {
    const dest = this.dests.get(webhookId);
    if (!dest) return;
    if (dest.timer) clearTimeout(dest.timer);
    dest.pending.forEach((job) => job.resolve());
    this.dests.delete(webhookId);
    webhookQueueDepth.set(this.totalPending());
  }

  private destination(webhookId: string): DestinationQueue {
    let dest = this.dests.get(webhookId);
    if (!dest) {
      dest = { webhookId, pending: [], running: false, consecutiveFailures: 0 };
      this.dests.set(webhookId, dest);
    }
    return dest;
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
    return { webhookId: webhook.id, payload, attempt: 0, succeeded: false, done, resolve };
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
      job.succeeded = true;
      job.resolve();
    } else if (attempt < config.webhooks.maxRetries) {
      retryDelayMs = backoffDelayMs(attempt);
      webhookDeliveriesTotal.inc({ result: 'retry_scheduled' });
    } else {
      dest.pending.shift();
      webhook.status = 'dead-letter';
      dest.consecutiveFailures += 1;
      webhookDeliveriesTotal.inc({ result: 'failed' });
      this.deadLetter(webhook, job, attempt);
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

  private deadLetter(webhook: WebhookRegistration, job: DeliveryJob, attempts: number): void {
    const entry: DeadLetterEntry = {
      id: randomUUID(),
      webhookId: webhook.id,
      apiKeyPrefix: webhook.apiKeyPrefix,
      url: webhook.url,
      trigger: webhook.trigger,
      payload: job.payload,
      attempts,
      failure: webhook.lastFailure || 'Delivery failed',
      createdAt: Date.now(),
    };
    const write = this.store.appendDeadLetter(entry).catch((err: unknown) => {
      logger.warn(`Failed to dead-letter delivery for webhook ${webhook.id}`, err);
    });
    this.pendingWrites.push(write);
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

        await this.logDelivery({
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
      await this.logDelivery({
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
