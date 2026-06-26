import { config } from './config';
import { logger } from './utils/logger';
import { ChainlinkSource, RedstoneSource, BandSource, ReflectorSource } from './sources';
import { PriceAggregator } from './aggregator';
import { AggregatedPrice } from './types';
import { ContractPublisher } from './publisher';
import { appendHistoricalPrice } from './utils/history';
import { BaseSource } from './sources/base';
import { WebSocketServer } from './ws-server';
import { HealthServer } from './health-server';

let lastAggregated: AggregatedPrice[] = [];
let aggregator: PriceAggregator;

async function poll(): Promise<AggregatedPrice[]> {
  const sources: BaseSource[] = [
    new ChainlinkSource(),
    new RedstoneSource(),
    new BandSource(),
    new ReflectorSource(),
  ];

  for (const source of sources) {
    const prices = await source.fetchAll(config.assets);
    for (const price of prices) {
      aggregator.updateSourcePrice(price);
      appendHistoricalPrice(price.asset, price.price.toString(), price.decimals, price.source, price.timestamp);
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

  // Initialize aggregator with circuit breaker
  aggregator = new PriceAggregator({
    deviationThreshold: 20,
    recoveryRequiredSuccesses: 3,
  });

  const wss = new WebSocketServer(config.port);
  wss.start();

  const healthServer = new HealthServer(config.port + 2, () => ({
    sourceHealth: {
      chainlink: new ChainlinkSource().health,
      redstone: new RedstoneSource().health,
      band: new BandSource().health,
      reflector: new ReflectorSource().health,
    },
    lastAggregated,
    circuitBreakerMetrics: aggregator.getCircuitBreakerMetrics(),
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
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error', err);
    process.exit(1);
  });
}
