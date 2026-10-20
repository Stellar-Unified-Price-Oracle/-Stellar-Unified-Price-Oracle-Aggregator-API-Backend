import { config, redactedConfigView } from './infrastructure/config';
import { brownoutPolicy } from './infrastructure/brownout';
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
import { KafkaReplicator } from './replication/kafka-replicator';
import { FeedReplicationMonitor } from './replication/feed-replication-monitor';
import { FeedHealthRouter } from './replication/feed-health-router';
import {
  oracleSourceUptimePercent,
  onChainPriceStalenessSeconds,
  onChainHeartbeatAlertsTotal,
  serviceStartupDurationMs,
  pipelineStageLatencyMs,
  pollCycleDurationMs,
  pollCycleOverrunsTotal,
  regionDriftKnown,
  regionDriftPercent,
  regionPeersConfigured,
  regionPeersReporting,
  brownoutTierGauge,
  brownoutShedTotal,
} from './observability/metrics';
import { DatabaseClient } from './persistence/database';
import { BaseSource } from './oracle-sources/base';
import { WebSocketServer } from './infrastructure/ws-server';
import { HealthServer } from './observability/health-server';
import { GracefulShutdownCoordinator, type ShutdownHooks } from './infrastructure/shutdown';
import AlertManager from './observability/alert-manager';
import { sourceCircuitBreaker } from './price-aggregation/source-circuit-breaker';
import { eventBus } from './domain-events';
import { decryptSecret } from './infrastructure/crypto';
import { flushDailyCounts } from './infrastructure/cost-model';
import { getVaultClient } from '@stellar-oracle/vault-client';
import {
  enforceStartupCardinalityBudget,
  setAllowedAssets,
  setAllowedSources,
} from './observability/cardinality';
import {
  resolveCellTopology,
  CellTopologyError,
  type CellTopology,
} from './infrastructure/cell-topology';

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

// Issue #736 — cell topology resolved once at module load so that feed
// partitioning, dependency routing and per-cell health/metrics all agree on
// the same cell assignment. A duplicate-feed claim is fatal (see main()).
let cellTopology: CellTopology | null = null;
let cellTopologyError: CellTopologyError | null = null;
try {
  cellTopology = resolveCellTopology(config);
} catch (err) {
  if (err instanceof CellTopologyError) {
    cellTopologyError = err;
  } else {
    throw err;
  }
}

const aggregator = new PriceAggregator();
const fileArchival = new FileArchivalService();
const regionReplicator = new RegionPriceReplicator();
const regionQuarantine = new RegionQuarantineManager();
// Issue #739 — per-feed replication lag and missing-sequence tracking.
const feedReplicationMonitor = new FeedReplicationMonitor({
  lagWarnMs: config.region.feedLagWarnMs,
  lagCriticalMs: config.region.feedLagCriticalMs,
  missingSequenceThreshold: config.region.feedMissingSequenceThreshold,
  windowSize: config.region.feedLagWindowSize,
});
// Issue #740 — consumer routing driven by per-feed freshness and integrity.
const feedHealthRouter = new FeedHealthRouter({
  priority: config.region.feedRoutingPriority,
  lagWarnMs: config.region.feedLagWarnMs,
  lagCriticalMs: config.region.feedLagCriticalMs,
  missingSequenceThreshold: config.region.feedMissingSequenceThreshold,
});
regionReplicator.setFeedMonitor(feedReplicationMonitor);
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
let publisher: ContractPublisher | null = null;
// Issue #579 — readiness flag flipped before any other shutdown step.
let shutdownInProgress = false;

async function poll(): Promise<AggregatedPrice[]> {
  // Issue #741 — evaluate brownout tier at the start of every cycle. Price
  // freshness and publication are never gated; only non-critical work is shed.
  const tierChange = brownoutPolicy.evaluate();
  if (tierChange) {
    brownoutTierGauge.set({ tier: tierChange.tier }, 1);
    for (const other of ['full', 'reduced', 'minimal'] as const) {
      if (other !== tierChange.tier) brownoutTierGauge.set({ tier: other }, 0);
    }
    logger[tierChange.tier === 'full' ? 'info' : 'warn'](`[Brownout] Tier ${tierChange.previous} -> ${tierChange.tier}`, {
      reason: tierChange.reason,
      shed: brownoutPolicy.getShedFeatures(),
    });
  }

  const sources: BaseSource[] = pollSources;
  const sourcePricesByAsset: Map<string, { source: string; price: string }[]> = new Map();
  const sourceFetchStarted = performance.now();

  // Issue #736 — only poll the feeds assigned to this deployment's cell. A
  // failure in this cell's dependencies therefore cannot stall feeds owned by
  // other cells, and vice versa.
  const cellAssets = cellTopology ? cellTopology.assets : config.assets;

  for (const source of sources) {
    const prices = await source.fetchAll(cellAssets);
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

      // Issue #741 — history persistence is non-critical; shed under reduced/minimal.
      if (brownoutPolicy.isFeatureEnabled('history_persistence')) {
        if (db && db.isInitialized()) {
          await db.appendHistoricalPrice(
            price.asset,
            price.price.toString(),
            price.decimals,
            price.source,
            price.timestamp,
          );
        } else {
          try {
            appendHistoricalPrice(price.asset, price.price.toString(), price.decimals, price.source, price.timestamp);
          } catch (err) {
            logger.error('Failed to append historical price for asset', {
              asset: price.asset,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        brownoutShedTotal.inc({ feature: 'history_persistence' });
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
  if (replicationPublisher) void replicationPublisher.publish();
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

    // Check price against alert thresholds (critical: always runs)
    await alertManager.checkPrice(ap);

    // Check for disagreement between live oracle sources — non-essential
    // webhook fan-out is shed under brownout, but the check itself is kept.
    const sourcePrices = sourcePricesByAsset.get(ap.asset);
    if (sourcePrices && brownoutPolicy.isFeatureEnabled('source_disagreement_alerts')) {
      await alertManager.checkSourceDisagreement(ap.asset, sourcePrices);
    } else if (sourcePrices) {
      brownoutShedTotal.inc({ feature: 'source_disagreement_alerts' });
    }
  }

  const drift = regionReplicator.getDriftReport();
  regionDriftPercent.set({ region: config.region.id }, drift.maxDriftPercent);
  regionDriftKnown.set({ region: config.region.id }, drift.driftKnown ? 1 : 0);
  regionPeersReporting.set({ region: config.region.id }, drift.peerCount);
  if (!drift.driftKnown && config.region.activeActive) {
    logger.warn('Cross-region drift cannot be computed: no peer region has reported', {
      region: config.region.id,
      regionCount: drift.regionCount,
      configuredPeers: config.region.peers,
    });
  }
  if (drift.maxDriftPercent > config.region.driftAlertPercent) {
    logger.warn('Cross-region price drift exceeds threshold', drift);
  }
  const quarantine = regionQuarantine.evaluate(drift, feedReplicationMonitor.getFeedHealthSnapshot());
  if (quarantine.transition) {
    logger[quarantine.quarantined ? 'error' : 'info'](`Region ${config.region.id} ${quarantine.transition}`, {
      quarantine,
      drift,
    });
    await alertManager.reportRegionQuarantine({
      region: config.region.id,
      transition: quarantine.transition,
      maxDriftPercent: drift.maxDriftPercent,
      thresholdPercent: config.region.driftAlertPercent,
      recoverPercent: config.region.quarantineRecoverPercent,
      driftKnown: drift.driftKnown,
      regionCount: drift.regionCount,
      peerCount: drift.peerCount,
    });
  }
  if (publisher) {
    publisher.setPublishingEnabled(
      !quarantine.quarantined,
      quarantine.quarantined ? quarantine.reason ?? 'cross-region drift' : 'quarantine cleared',
    );
  }

  // Issue #739/#740 — evaluate per-feed health and route consumers accordingly.
  const feedHealth = feedReplicationMonitor.evaluate();
  const routingDecision = feedHealthRouter.route(feedHealth);
  if (routingDecision.failover) {
    logger.warn('Feed health routing triggered failover', {
      region: config.region.id,
      decision: routingDecision,
    });
    await alertManager.reportFeedHealthFailover({
      region: config.region.id,
      decision: routingDecision,
      feeds: feedHealth,
    });
  }
  for (const feed of feedHealth) {
    if (feed.status === 'critical') {
      logger.error('Feed replication lag critical', { region: config.region.id, feed });
    } else if (feed.status === 'degraded') {
      logger.warn('Feed replication lag degraded', { region: config.region.id, feed });
    }
  }

  const unhealthy = sources.filter((s) => !s.health.healthy);
  if (unhealthy.length > 0) {
    logger.warn(`Unhealthy sources: ${unhealthy.map((s) => s.name).join(', ')}`);
  }

  if (config.soroban.contractId && publisher) {
    const published = await tryCatchAsync(() => publisher!.publishAggregated(aggregated));
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
    for (const asset of cellTopology ? cellTopology.assets : config.assets) {
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
    // Issue #741 — uptime history snapshots are non-critical background work.
    if (brownoutPolicy.isFeatureEnabled('uptime_history')) {
      appendUptimeSnapshot(source.name, source.health);
    } else {
      brownoutShedTotal.inc({ feature: 'uptime_history' });
    }
    oracleSourceUptimePercent.set({ source: source.name }, source.health.uptimePercent);
  }

  return aggregated;
}

async function main(): Promise<void> {
  logger.info('Stellar Price Oracle Aggregator starting...');

  // Issue #736 — refuse to start if two cells claim the same feed. Overlapping
  // ownership would let one cell's failure bleed into another's feeds.
  if (cellTopologyError || !cellTopology) {
    logger.error('Cell topology is invalid; refusing to start', {
      error: cellTopologyError?.message ?? 'cell topology not resolved',
      duplicates: cellTopologyError?.duplicates ?? [],
    });
    process.exit(1);
  }

  logger.info('Cell topology resolved', {
    cellId: cellTopology.cellId,
    assets: cellTopology.assets,
    dependencies: cellTopology.dependencies,
    cells: cellTopology.cells.map((c) => ({ cellId: c.cellId, assets: c.assets })),
  });

  logger.info(`Polling interval: ${config.pollingIntervalMs}ms`);
  logger.info(`Watched assets (cell ${cellTopology.cellId}): ${cellTopology.assets.join(', ')}`);
  logger.info(
    'Resolved configuration (redacted)',
    redactedConfigView(config) as Record<string, unknown>,
  );

  // Enforce Prometheus cardinality budget for configured sources and assets (#553)
  // Issue #736 — scope the budget to this cell's feeds only.
  enforceStartupCardinalityBudget(['chainlink', 'redstone', 'band', 'reflector'], cellTopology.assets);
  setAllowedAssets(cellTopology.assets);
  setAllowedSources(['chainlink', 'redstone', 'band', 'reflector']);

  for (const asset of cellTopology.assets) {
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

  const resolvedPorts = { base: config.port, ws: config.port + 1, http: config.port + 2 };

  const wss = new WebSocketServer(config.port);
  wss.start();

  // Issue #736 — route each source through this cell's dependency endpoints so
  // a dependency outage is confined to the cell that depends on it.
  const persistentSources = {
    chainlink: new ChainlinkSource({ endpoint: cellTopology.dependencies.chainlink }),
    redstone: new RedstoneSource({ endpoint: cellTopology.dependencies.redstone }),
    band: new BandSource({ endpoint: cellTopology.dependencies.band }),
    reflector: new ReflectorSource({ endpoint: cellTopology.dependencies.reflector }),
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
    // Issue #736 — per-cell health so operators can see which cell owns which
    // feeds and whether this cell's dependencies are degraded.
    cell: {
      cellId: cellTopology.cellId,
      assets: cellTopology.assets,
      dependencies: cellTopology.dependencies,
    },
    circuitBreakerMetrics: aggregator.getCircuitBreakerMetrics(),
    circuitBreakerStates: sourceCircuitBreaker.getAllStatuses(),
    uptime: process.uptime(),
    startupTimeMs,
    onChainHeartbeat,
    ports: resolvedPorts,
    brownout: brownoutPolicy.getStatus(),
  }));
  healthServer.start();
  logger.info(
    `Resolved ports: ws=${resolvedPorts.ws} health+metrics=${resolvedPorts.http} ` +
      `(PORT base ${resolvedPorts.base}; no listener on the base port)`,
  );

  regionPeersConfigured.set({ region: config.region.id }, config.region.peers.length);
  // Issue #736 — per-cell metrics: feed ownership and dependency endpoints.
  cellFeedsAssigned.set({ cell: cellTopology.cellId }, cellTopology.assets.length);
  for (const [source, endpoint] of Object.entries(cellTopology.dependencies)) {
    cellDependencyEndpointInfo.set({ cell: cellTopology.cellId, source }, endpoint);
  }
  if (config.region.activeActive && config.kafka.brokers.length > 0) {
    replicationPublisher = new KafkaReplicator(
      {
        regionId: config.region.id,
        kafkaBrokers: config.kafka.brokers,
        replicationTopic: config.region.replicationTopic,
        consumerGroup: `${config.region.id}-replication`,
        maxReplicationLagMs: config.region.maxReplicationLagMs,
        sslEnabled: config.kafka.sslEnabled,
      },
      regionReplicator,
    );
    await replicationPublisher.ensureStarted();
  } else {
    logger.info('Cross-region replication disabled', {
      activeActive: config.region.activeActive,
      brokersConfigured: config.kafka.brokers.length,
      peers: config.region.peers,
    });
  }

  if (config.soroban.contractId) {
    publisher = new ContractPublisher();
    logger.info('Initialized process-scoped ContractPublisher');
  }

  await poll();
  startupTimeMs = Date.now() - startupStartedAt;
  serviceStartupDurationMs.set({ service: 'aggregator' }, startupTimeMs);
  logger.info(`Aggregator startup complete in ${startupTimeMs}ms`);

  // Issue #575 — Self-scheduling poll loop with single-flight execution and deadline
  let isPolling = false;
  let pollTimeout: NodeJS.Timeout | null = null;
  let isShuttingDown = false;
  let consecutiveOverruns = 0;
  const OVERRUN_ALERT_THRESHOLD = 3;

  // Issue #579 — resolved when the cycle in flight at shutdown time finishes;
  // the shutdown coordinator awaits it under the drain deadline.
  let resolveInFlightCycle: (() => void) | null = null;

  async function runPollWithDeadline(deadlineMs: number): Promise<AggregatedPrice[]> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Poll cycle exceeded deadline of ${deadlineMs}ms`)), deadlineMs);
    });
    try {
      return await Promise.race([poll(), timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  async function executeCycle(): Promise<void> {
    if (isShuttingDown) return;

    if (isPolling) {
      pollCycleOverrunsTotal.inc();
      consecutiveOverruns++;
      logger.warn('[PollLoop] Overrun detected: previous cycle still in flight; skipping overlapping tick');
      if (consecutiveOverruns >= OVERRUN_ALERT_THRESHOLD) {
        logger.error(`[PollLoop] Sustained overrun alert: ${consecutiveOverruns} consecutive cycles exceeded polling interval ${config.pollingIntervalMs}ms`);
      }
      return;
    }

    isPolling = true;
    const cycleStart = performance.now();
    const deadlineMs = Math.max(10_000, config.pollingIntervalMs * 1.5);

    try {
      const prices = await runPollWithDeadline(deadlineMs);
      wss.broadcast({ type: 'price_update', data: prices });
    } catch (err) {
      logger.error('Poll cycle failed or timed out', err);
    } finally {
      const elapsedMs = performance.now() - cycleStart;
      isPolling = false;
      pollCycleDurationMs.observe(elapsedMs);

      if (elapsedMs > config.pollingIntervalMs) {
        pollCycleOverrunsTotal.inc();
        consecutiveOverruns++;
        logger.warn(`[PollLoop] Cycle duration ${elapsedMs.toFixed(0)}ms exceeded interval ${config.pollingIntervalMs}ms`);
      } else {
        consecutiveOverruns = 0;
      }

      // Issue #579 — release the shutdown coordinator if it is waiting on us.
      if (resolveInFlightCycle) {
        const resolve = resolveInFlightCycle;
        resolveInFlightCycle = null;
        resolve();
      }

      if (!isShuttingDown) {
        // Overrun policy: skip tick and schedule next execution after remaining interval or minimum 1000ms delay
        const nextDelay = Math.max(1000, config.pollingIntervalMs - elapsedMs);
        pollTimeout = setTimeout(executeCycle, nextDelay);
      }
    }
  }

  // Schedule first self-scheduling recurring tick
  pollTimeout = setTimeout(executeCycle, config.pollingIntervalMs);

  // Issue #741 — file archival is a non-critical background job; it is started
  // only when the current tier permits it and re-evaluated on tier changes.
  if (brownoutPolicy.isFeatureEnabled('file_archival')) {
    fileArchival.start();
  } else {
    brownoutShedTotal.inc({ feature: 'file_archival' });
  }

  // Issue #579 — one idempotent handler covers SIGTERM and SIGINT.
  const shutdownHooks: ShutdownHooks = {
    flipReadiness: () => {
      shutdownInProgress = true;
      isShuttingDown = true;
      logger.info('[Shutdown] Readiness flipped to not-ready; waiting for the in-flight poll cycle to finish');
    },
    stopScheduledWork: () => {
      if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
      }
      fileArchival.stop();
    },
    waitForInFlightCycle: async () => {
      if (!isPolling) return true;
      const drained = await Promise.race([
        new Promise<boolean>((resolve) => {
          resolveInFlightCycle = () => resolve(true);
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), config.shutdown.drainDeadlineMs)),
      ]);
      resolveInFlightCycle = null;
      return drained;
    },
    drainRetryQueue: async () => {
      if (!publisher) return;
      await publisher.shutdown();
    },
    closeServers: async () => {
      // #583 — flush persisted daily call counters so budgets survive restarts.
      flushDailyCounts();
      // #739 — flush final per-feed lag metrics before listeners close.
      feedReplicationMonitor.flushMetrics();
      wss.stop();
      healthServer.stop();
    },
    disconnectDatabase: async () => {
      if (!db) return;
      await db.disconnect();
    },
  };

  const shutdownCoordinator = new GracefulShutdownCoordinator(shutdownHooks, {
    drainDeadlineMs: config.shutdown.drainDeadlineMs,
    forceExitMs: config.shutdown.forceExitMs,
  });
  shutdownCoordinator.register(['SIGTERM', 'SIGINT']);

  // Issue #741 — react to tier transitions: start/stop non-critical background
  // jobs as the tier changes. Price polling and publication are never touched.
  brownoutPolicy.onTierChange((change) => {
    if (change.tier === 'full') {
      fileArchival.start();
    } else {
      fileArchival.stop();
    }
  });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error', err);
    process.exit(1);
  });
}
