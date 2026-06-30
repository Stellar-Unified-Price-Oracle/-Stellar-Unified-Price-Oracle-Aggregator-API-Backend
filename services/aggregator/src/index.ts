import { config } from './config';
import { logger } from './utils/logger';
import { ChainlinkSource, RedstoneSource, BandSource, ReflectorSource } from './sources';
import { PriceAggregator } from './aggregator';
import { AggregatedPrice } from './types';
import { ContractPublisher } from './publisher';
import { appendHistoricalPrice } from './utils/history';
import { DatabaseClient } from './utils/database';
import { BaseSource } from './sources/base';
import { WebSocketServer } from './ws-server';
import { HealthServer } from './health-server';
import AlertManager, { AlertThresholds } from './alert-manager';
import { sourceCircuitBreaker } from './source-circuit-breaker';

const aggregator = new PriceAggregator();
const alertManager = new AlertManager({
  webhookUrl: process.env.ALERT_WEBHOOK_URL,
  slackWebhookUrl: process.env.ALERT_SLACK_WEBHOOK_URL,
  pagerDutyRoutingKey: process.env.ALERT_PAGERDUTY_ROUTING_KEY,
  emailWebhookUrl: process.env.ALERT_EMAIL_WEBHOOK_URL,
  emailRecipients: (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sourceDisagreementThresholdPercent: parseFloat(process.env.ALERT_SOURCE_DISAGREEMENT_PERCENT || '5'),
});

let lastAggregated: AggregatedPrice[] = [];
let db: DatabaseClient | null = null;
let pollSources: BaseSource[] = [];

async function poll(): Promise<AggregatedPrice[]> {
  const sources: BaseSource[] = pollSources;
  const sourcePricesByAsset: Map<string, { source: string; price: string }[]> = new Map();

  for (const source of sources) {
    const prices = await source.fetchAll(config.assets);
    for (const price of prices) {
      aggregator.updateSourcePrice(price);

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
  }

  const aggregated = aggregator.getAllPrices();
  for (const ap of aggregated) {
    const usdPrice = BigInt(ap.price) / BigInt(10n ** BigInt(ap.decimals));
    const healthStatuses = sources.map((s) => ({
      name: s.name,
      healthy: s.health.healthy,
      uptime: `${s.health.uptimePercent}%`,
      consecutiveFailures: s.health.consecutiveFailures,
    }));
    logger.info(`Aggregated ${ap.asset}: ~$${usdPrice} (sources: ${ap.sources.join(', ')}, confidence: ${(ap.confidence * 100).toFixed(0)}%)`, { health: healthStatuses });

    // Check price against alert thresholds
    await alertManager.checkPrice(ap);

    // Check for disagreement between live oracle sources
    const sourcePrices = sourcePricesByAsset.get(ap.asset);
    if (sourcePrices) {
      await alertManager.checkSourceDisagreement(ap.asset, sourcePrices);
    }
  }

  const unhealthy = sources.filter((s) => !s.health.healthy);
  if (unhealthy.length > 0) {
    logger.warn(`Unhealthy sources: ${unhealthy.map((s) => s.name).join(', ')}`);
  }

  if (config.soroban.contractId) {
    const publisher = new ContractPublisher();
    await publisher.publishAggregated(aggregated);
  }

  lastAggregated = aggregated;
  return aggregated;
}

async function main(): Promise<void> {
  logger.info('Stellar Price Oracle Aggregator starting...');
  logger.info(`Polling interval: ${config.pollingIntervalMs}ms`);
  logger.info(`Watched assets: ${config.assets.join(', ')}`);

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

  const healthServer = new HealthServer(config.port + 2, () => ({
    sourceHealth: {
      chainlink: persistentSources.chainlink.health,
      redstone: persistentSources.redstone.health,
      band: persistentSources.band.health,
      reflector: persistentSources.reflector.health,
    },
    lastAggregated,
    circuitBreakerMetrics: aggregator.getCircuitBreakerMetrics(),
    circuitBreakerStates: sourceCircuitBreaker.getAllStatuses(),
    uptime: process.uptime(),
  }));
  healthServer.start();

  await poll();

  setInterval(async () => {
    try {
      const prices = await poll();
      wss.broadcast({ type: 'price_update', data: prices });
    } catch (err) {
      logger.error('Poll cycle failed', err);
    }
  }, config.pollingIntervalMs);

  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
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
