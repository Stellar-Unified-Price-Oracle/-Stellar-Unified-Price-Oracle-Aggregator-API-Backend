import { config } from './infrastructure/config';
import { tryCatchAsync } from './infrastructure/result';
import { logger } from './observability/logger';
import { ChainlinkSource, RedstoneSource, BandSource, ReflectorSource } from './oracle-sources';
import { PriceAggregator } from './price-aggregation/aggregator';
import { anomalyDetector } from './price-aggregation/anomaly-detector';
import { AggregatedPrice, type OracleSourceName } from './infrastructure/types';
import { ContractPublisher } from './contract-publishing/publisher';
import { appendHistoricalPrice } from './persistence/history';
import { appendUptimeSnapshot } from './persistence/uptime-history';
import { FileArchivalService } from './persistence/file-archival';
import { RegionPriceReplicator } from './replication/region-price-replicator';
import { RegionQuarantineManager } from './replication/region-quarantine';
import { oracleSourceUptimePercent, onChainPriceStalenessSeconds, onChainHeartbeatAlertsTotal, serviceStartupDurationMs, pipelineStageLatencyMs } from './observability/metrics';
import { DatabaseClient } from './persistence/database';
import { BaseSource } from './oracle-sources/base';
import { WebSocketServer } from './infrastructure/ws-server';
import { HealthServer } from './observability/health-server';
import AlertManager from './observability/alert-manager';
import { sourceCircuitBreaker } from './price-aggregation/source-circuit-breaker';
import { eventBus } from './domain-events';
import { decryptSecret } from './infrastructure/crypto';
import { getVaultClient } from '@stellar-oracle/vault-client';

// In-process counters surfaced as structured log lines; the API /metrics
// endpoint (prom-client) collects the canonical Prometheus metrics.
const internalCounters = {
  priceUpdates: new Map<string, number>(),
  anomalies: new Map<string, number>(),
};

function incPriceUpdate(asset: string, source: string): void {
  const key = `${asset}:${source}`;
  internalCounters.priceUpdates.set(key, (internalCounters.priceUpdates.get(key) ?? 0) + 1);
}

function incAnomaly(asset: string, method: string): void {
  const key = `${asset}:${method}`;
  internalCounters.anomalies.set(key, (internalCounters.anomalies.get(key) ?? 0) + 1);
}

const aggregator = new PriceAggregator();
const fileArchival = new FileArchivalService();
const regionReplicator = new RegionPriceReplicator();
const regionQuarantine = new RegionQuarantineManager();
const alertManager = new AlertManager({
  webhookUrl: process.env.ALERT_WEBHOOK_URL ? decryptSecret(process.env.ALERT_WEBHOOK_URL) : undefined,
  slackWebhookUrl: process.env.ALERT_SLACK_WEBHOOK_URL ? decryptSecret(process.env.ALERT_SLACK_WEBHOOK_URL) : undefined,
  pagerDutyRoutingKey: process.env.ALERT_PAGERDUTY_ROUTING_KEY ? decryptSecret(process.env.ALERT_PAGERDUTY_ROUTING_KEY) : undefined,
  opsGenieApiKey: process.env.ALERT_OPSGENIE_API_KEY ? decryptSecret(process.env.ALERT_OPSGENIE_API_KEY) : undefined,
  emailWebhookUrl: process.env.ALERT_EMAIL_WEBHOOK_URL ? decryptSecret(process.env.ALERT_EMAIL_WEBHOOK_URL) : undefined,
  emailRecipients: (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sourceDisagreementThresholdPercent: parseFloat(process.env.ALERT_SOURCE_DISAGREEMENT_PERCENT || '5'),
  slaBreachMaxPerWindow: parseInt(process.env.ALERT_SLA_BREACH_MAX_PER_WINDOW || '10', 10),
  slaBreachWindowSeconds: parseInt(process.env.ALERT_SLA_BREACH_WINDOW_SECONDS || '300', 10),
});

let lastAggregated: AggregatedPrice[] = [];
const startupStartedAt = Date.now();
let startupTimeMs = 0;
// Issue #382 — on-chain price staleness heartbeat, seconds since last on-chain
// update per asset; surfaced on the /health status page.
const onChainHeartbeat: Record<string, number> = {};
let db: DatabaseClient | null = null;
let pollSources: BaseSource[] = [];

async function poll(): Promise<AggregatedPrice[]> {
  const sources: BaseSource[] = pollSources;
  const sourcePricesByAsset: Map<string, { source: string; price: string }[]> = new Map();
  const sourceFetchStarted = performance.now();

  for (const source of sources) {
    const prices = await source.fetchAll(config.assets);
    for (const price of prices) {
      // Publish PriceFetchedEvent
      eventBus.publish({
        type: 'price_fetched',
        payload: price,
        timestamp: Date.now(),
      });

      aggregator.updateSourcePrice(price);
      incPriceUpdate(price.asset, price.source);

      const list = sourcePricesByAsset.get(price.asset) || [];
      list.push({ source: price.source, price: price.price.toString() });
      sourcePricesByAsset.set(price.asset, list);

      if (db && db.isInitialized()) {
        await db.appendHistoricalPrice(
          price.asset,
          price.price.toString(),
          price.decimals,
          price.source,
          price.timestamp,
        );
      } else {
        appendHistoricalPrice(price.asset, price.price.toString(), price.decimals, price.source, price.timestamp);
      }
    }

    // Publish SourceDegradedEvent if source is unhealthy
    if (!source.health.healthy) {
      eventBus.publish({
        type: 'source_degraded',
        payload: {
          source: source.name,
          reason: 'Source is unhealthy',
        },
        timestamp: Date.now(),
      });
    }
  }

  pipelineStageLatencyMs.observe({ stage: 'source_fetch', status: 'ok' }, performance.now() - sourceFetchStarted);

  const aggregationStarted = performance.now();
  const aggregated = aggregator.getAllPrices();
  pipelineStageLatencyMs.observe({ stage: 'aggregation', status: 'ok' }, performance.now() - aggregationStarted);

  const replicationStarted = performance.now();
  regionReplicator.mergeLocalPrices(aggregated);
  pipelineStageLatencyMs.observe({ stage: 'replication', status: 'ok' }, performance.now() - replicationStarted);
  const allSourceNames = ['chainlink', 'redstone', 'band', 'reflector'];
  for (const ap of aggregated) {
    // Publish PriceAggregatedEvent
    eventBus.publish({
      type: 'price_aggregated',
      payload: ap,
      timestamp: Date.now(),
    });

    const usdPrice = BigInt(ap.price) / (10n ** BigInt(ap.decimals));
    const healthStatuses = sources.map((s) => ({
      name: s.name,
      healthy: s.health.healthy,
      uptime: `${s.health.uptimePercent}%`,
      consecutiveFailures: s.health.consecutiveFailures,
    }));
    logger.info(`Aggregated ${ap.asset}: ~$${usdPrice} (sources: ${ap.sources.join(', ')}, confidence: ${(ap.confidence * 100).toFixed(0)}%)`, { health: healthStatuses });

    for (const src of ap.sources) {
      incPriceUpdate(ap.asset, src);
    }

    const participation: Record<string, number> = {};
    for (const src of allSourceNames) {
      participation[src] = ap.sources.includes(src as OracleSourceName) ? 1 : 0;
    }
    logger.debug(`[Metrics] Source participation for ${ap.asset}`, participation);

    if (ap.anomaly) {
      // Publish AnomalyDetectedEvent
      eventBus.publish({
        type: 'anomaly_detected',
        payload: {
          asset: ap.asset,
          anomaly: ap.anomaly,
        },
        timestamp: Date.now(),
      });

      incAnomaly(ap.asset, ap.anomaly.method);
      logger.warn(`[Anomaly] ${ap.asset} score=${ap.anomaly.score.toFixed(3)} method=${ap.anomaly.method}: ${ap.anomaly.details}`);
    }

    // Check price against alert thresholds
    await alertManager.checkPrice(ap);

    // Check for disagreement between live oracle sources
    const sourcePrices = sourcePricesByAsset.get(ap.asset);
    if (sourcePrices) {
      await alertManager.checkSourceDisagreement(ap.asset, sourcePrices);
    }
  }

  const drift = regionReplicator.getDriftReport();
  if (drift.maxDriftPercent > config.region.driftAlertPercent) {
    logger.warn('Cross-region price drift exceeds threshold', drift);
  }
  const quarantine = regionQuarantine.evaluate(drift);
  if (quarantine.quarantined) {
    logger.error(`Region ${config.region.id} quarantined due to cross-region price drift`, quarantine);
  }

  const unhealthy = sources.filter((s) => !s.health.healthy);
  if (unhealthy.length > 0) {
    logger.warn(`Unhealthy sources: ${unhealthy.map((s) => s.name).join(', ')}`);
  }

  if (config.soroban.contractId) {
    const publisher = new ContractPublisher();
    const published = await tryCatchAsync(() => publisher.publishAggregated(aggregated));
    if (!published.ok) {
      logger.error('Failed to publish aggregated prices to the contract', {
        assetCount: aggregated.length,
        error: published.error.message,
        errorStack: published.error.stack,
      });
    }

    // Publish PricePublishedEvent
    eventBus.publish({
      type: 'price_published',
      payload: aggregated,
      timestamp: Date.now(),
    });

    // Issue #382 — on-chain price staleness heartbeat: detect when the
    // contract itself stops receiving submissions, independent of whether
    // this aggregator process looks healthy.
    for (const asset of config.assets) {
      const onChainTimestamp = await publisher.getOnChainTimestamp(asset);
      if (onChainTimestamp === null) continue;

      const ageSeconds = Math.floor(Date.now() / 1000) - onChainTimestamp;
      onChainPriceStalenessSeconds.set({ asset }, ageSeconds);

      const isStale = await alertManager.checkOnChainHeartbeat(
        asset,
        onChainTimestamp,
        Math.floor(config.stalenessThresholdMs / 1000),
      );
      if (isStale) {
        onChainHeartbeatAlertsTotal.inc({ asset });
      }
      onChainHeartbeat[asset] = ageSeconds;
    }
  }

  lastAggregated = aggregated;

  for (const source of sources) {
    appendUptimeSnapshot(source.name, source.health);
    oracleSourceUptimePercent.set({ source: source.name }, source.health.uptimePercent);
  }

  return aggregated;
}

async function main(): Promise<void> {
  logger.info('Stellar Price Oracle Aggregator starting...');
  logger.info(`Polling interval: ${config.pollingIntervalMs}ms`);
  logger.info(`Watched assets: ${config.assets.join(', ')}`);

  for (const asset of config.assets) {
    anomalyDetector.applyRuntimeConfig(asset);
    const summary = anomalyDetector.getConfigSummary(asset);
    logger.info(`[AnomalyConfig] ${asset}: zscore=${summary.config.zScoreThreshold}, deviation=${summary.config.movingAverageDeviationPercent}%, volatility=${summary.config.volatilityMultiplier}, false_positive_rate=${summary.falsePositiveRate.toFixed(3)}`);
  }

  // Initialize Vault for contract admin key management
  try {
    const vault = getVaultClient();
    await vault.initialize();

    // Load contract admin key from Vault; fall back to env if not present
    const vaultAdmin = await vault.loadContractAdmin();
    if (vaultAdmin && !process.env.ADMIN_SECRET_KEY) {
      process.env.ADMIN_SECRET_KEY = decryptSecret(vaultAdmin.secretKey);
      logger.info('Loaded contract admin key from Vault');
    } else if (!vaultAdmin && process.env.ADMIN_SECRET_KEY) {
      await vault.seedDefaults({
        contractAdmin: {
          secretKey: process.env.ADMIN_SECRET_KEY,
          contractId: config.soroban.contractId,
          networkPassphrase: config.soroban.networkPassphrase,
          label: 'default-admin',
        },
      });
      logger.info('Seeded contract admin key into Vault from environment');
    }
    logger.info('Vault secrets engine initialized');
  } catch (err) {
    logger.warn('Vault not available — using environment-based secrets fallback', err);
  }

  if (!config.soroban.contractId) {
    logger.warn('No contract ID configured — running in dry-run mode');
  }

  if (config.database.url) {
    try {
      db = new DatabaseClient(config.database.url, logger);
      await db.initialize();
      logger.info('PostgreSQL database connected');
    } catch (err) {
      logger.warn('Failed to connect to PostgreSQL, falling back to file-based storage', err);
      db = null;
    }
  } else {
    logger.info('DATABASE_URL not configured, using file-based storage');
  }

  const wss = new WebSocketServer(config.port);
  wss.start();

  const persistentSources = {
    chainlink: new ChainlinkSource(),
    redstone: new RedstoneSource(),
    band: new BandSource(),
    reflector: new ReflectorSource(),
  };
  pollSources = Object.values(persistentSources);

  // Subscribe to SLA breach events and route to alert manager
  eventBus.subscribe('sla_breach', (event) => {
    if (event.type === 'sla_breach') {
      alertManager.checkSlaBreach(
        event.payload.source,
        event.payload.asset,
        event.payload.elapsedSeconds,
      );
    }
  });

  const healthServer = new HealthServer(config.port + 2, () => ({
    sourceHealth: {
      chainlink: persistentSources.chainlink.health,
      redstone: persistentSources.redstone.health,
      band: persistentSources.band.health,
      reflector: persistentSources.reflector.health,
    },
    lastAggregated,
    replicatedPrices: regionReplicator.getLatestPrices(),
    region: regionQuarantine.getStatus(),
    circuitBreakerMetrics: aggregator.getCircuitBreakerMetrics(),
    circuitBreakerStates: sourceCircuitBreaker.getAllStatuses(),
    uptime: process.uptime(),
    startupTimeMs,
    onChainHeartbeat,
  }));
  healthServer.start();

  await poll();
  startupTimeMs = Date.now() - startupStartedAt;
  serviceStartupDurationMs.set({ service: 'aggregator' }, startupTimeMs);
  logger.info(`Aggregator startup complete in ${startupTimeMs}ms`);

  setInterval(async () => {
    try {
      const prices = await poll();
      wss.broadcast({ type: 'price_update', data: prices });
    } catch (err) {
      logger.error('Poll cycle failed', err);
    }
  }, config.pollingIntervalMs);

  fileArchival.start();

  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    fileArchival.stop();
    wss.stop();
    healthServer.stop();
    if (db) {
      db.disconnect().catch((err) => logger.error('Error disconnecting from database', err));
    }
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error', err);
    process.exit(1);
  });
}
