import { CompressionTypes, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import { KafkaBusClient, DEFAULT_TOPIC_CONFIG } from './kafka-bus-client';
import { RegionPriceReplicator } from './region-price-replicator';
import { logger } from '../observability/logger';
import {
  replicationBusUp,
  replicationPublishFailuresTotal,
  replicationRecordsInboundTotal,
  replicationRecordsOutboundTotal,
  replicationStaleEpochRejectedTotal,
} from '../observability/metrics';
import { FeedReplicationMonitor } from './feed-replication-monitor';

const RECONNECT_INTERVAL_MS = 30_000;

export interface KafkaReplicatorConfig {
  regionId: string;
  kafkaBrokers: string[];
  replicationTopic: string;
  consumerGroup: string;
  maxReplicationLagMs: number;
  sslEnabled: boolean;
}

interface ReplicationEnvelope {
  region?: unknown;
  asset?: unknown;
  price?: unknown;
  decimals?: unknown;
  timestamp?: unknown;
  sequence?: unknown;
  traceparent?: unknown;
  tracestate?: unknown;
  epoch?: unknown;
}

export class KafkaReplicator {
  private kafkaClient: KafkaBusClient;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private connecting = false;
  private consumerStarted = false;
  private lastConnectAttempt = 0;
  private replicationLagMs = 0;
  private readonly feedMonitor = new FeedReplicationMonitor();

  constructor(
    private readonly kafkaConfig: KafkaReplicatorConfig,
    private readonly replicator: RegionPriceReplicator,
  ) {
    this.kafkaClient = new KafkaBusClient({
      brokers: kafkaConfig.kafkaBrokers,
      clientId: `${kafkaConfig.regionId}-price-replicator`,
      sslEnabled: kafkaConfig.sslEnabled,
      saslEnabled: false,
    });
  }

  get isRunning(): boolean {
    return this.producer !== null && this.consumer !== null;
  }

  get enabled(): boolean {
    return this.kafkaConfig.kafkaBrokers.length > 0;
  }

  async ensureStarted(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.isRunning || this.connecting) return this.isRunning;

    const now = Date.now();
    if (this.lastConnectAttempt !== 0 && now - this.lastConnectAttempt < RECONNECT_INTERVAL_MS) {
      return false;
    }

    this.connecting = true;
    this.lastConnectAttempt = now;
    try {
      await this.start();
      replicationBusUp.set({ region: this.kafkaConfig.regionId }, 1);
      logger.info('Cross-region replication started', {
        region: this.kafkaConfig.regionId,
        brokers: this.kafkaConfig.kafkaBrokers,
        topic: this.kafkaConfig.replicationTopic,
        consumerGroup: this.kafkaConfig.consumerGroup,
      });
      return true;
    } catch (error) {
      replicationBusUp.set({ region: this.kafkaConfig.regionId }, 0);
      logger.error('Cross-region replication unavailable; continuing without peers', error);
      return false;
    } finally {
      this.connecting = false;
    }
  }

  async shutdown(): Promise<void> {
    this.producer = null;
    this.consumer = null;
    this.consumerStarted = false;
    try {
      await this.kafkaClient.disconnect();
    } catch (error) {
      logger.warn('Error while shutting down the replication bus', error);
    }
    replicationBusUp.set({ region: this.kafkaConfig.regionId }, 0);
    logger.info('Cross-region replication stopped');
  }

  async publish(): Promise<void> {
    if (!this.enabled) return;

    const records = this.replicator.getLocalPrices();
    if (records.length === 0) return;

    if (!this.isRunning && !(await this.ensureStarted())) {
      replicationPublishFailuresTotal.inc({ region: this.kafkaConfig.regionId });
      return;
    }

    const epoch = this.replicator.getFencingEpoch();

    try {
      const messages = records.map((record) => {
        const trace = this.replicator.outboundTraceHeaders(record.asset);
        const headers: Record<string, string> = {};
        if (trace.traceparent) headers.traceparent = trace.traceparent;
        if (trace.tracestate) headers.tracestate = trace.tracestate;
        headers.fencingEpoch = String(epoch);
        return {
          key: `${this.kafkaConfig.regionId}:${record.asset}`,
          value: JSON.stringify({
            region: this.kafkaConfig.regionId,
            asset: record.asset,
            price: record.price.toString(),
            decimals: record.decimals,
            source: 'local',
            timestamp: record.timestamp,
            wallClock: Date.now(),
            sequence,
            traceparent: trace.traceparent,
            tracestate: trace.tracestate,
            epoch,
          }),
          headers,
          timestamp: Date.now().toString(),
        };
      });

      await this.producer!.send({
        topic: this.kafkaConfig.replicationTopic,
        messages,
        compression: CompressionTypes.GZIP,
        timeout: 30_000,
      });

      replicationRecordsOutboundTotal.inc({ region: this.kafkaConfig.regionId }, records.length);
      replicationBusUp.set({ region: this.kafkaConfig.regionId }, 1);
    } catch (error) {
      replicationPublishFailuresTotal.inc({ region: this.kafkaConfig.regionId });
      replicationBusUp.set({ region: this.kafkaConfig.regionId }, 0);
      logger.error('Failed to publish local prices to the replication bus', error);
    }
  }

  async handleReplicatedMessage(payload: EachMessagePayload): Promise<void> {
    try {
      const { message } = payload;
      if (!message.value) return;

      const record: ReplicationEnvelope = JSON.parse(message.value.toString());
      if (
        typeof record.region !== 'string' ||
        typeof record.asset !== 'string' ||
        typeof record.price !== 'string' ||
        record.region === this.kafkaConfig.regionId
      ) {
        return;
      }

      const epoch =
        typeof record.epoch === 'number' && Number.isFinite(record.epoch) ? record.epoch : undefined;

      if (epoch !== undefined && this.replicator.isStaleEpoch(record.region, epoch)) {
        replicationStaleEpochRejectedTotal.inc({
          region: this.kafkaConfig.regionId,
          source_region: record.region,
        });
        logger.warn('Rejected replicated price with stale fencing epoch', {
          region: this.kafkaConfig.regionId,
          sourceRegion: record.region,
          asset: record.asset,
          epoch,
          currentEpoch: this.replicator.getFencingEpoch(),
        });
        return;
      }

      const publishedAt = Number(message.timestamp ?? 0);
      if (Number.isFinite(publishedAt) && publishedAt > 0) {
        this.replicationLagMs = Math.max(this.replicationLagMs, Date.now() - publishedAt);
      }

      const sequence = typeof record.sequence === 'number' ? record.sequence : undefined;
      this.feedMonitor.observe({
        feed: record.asset,
        sourceRegion: record.region,
        sequence,
        sourceTimestampMs: typeof record.timestamp === 'number' ? record.timestamp : undefined,
        receivedAtMs: Date.now(),
        maxLagMs: this.kafkaConfig.maxReplicationLagMs,
      });

      this.replicator.mergeRemotePrice({
        region: record.region,
        asset: record.asset,
        price: BigInt(record.price),
        decimals: typeof record.decimals === 'number' ? record.decimals : 0,
        timestamp: typeof record.timestamp === 'number' ? record.timestamp : 0,
        traceparent: typeof record.traceparent === 'string' ? record.traceparent : undefined,
        tracestate: typeof record.tracestate === 'string' ? record.tracestate : undefined,
        epoch,
      });

      replicationRecordsInboundTotal.inc({
        region: this.kafkaConfig.regionId,
        source_region: record.region,
      });
      replicationBusUp.set({ region: this.kafkaConfig.regionId }, 1);
      logger.debug(`Merged replicated price from ${record.region} for ${record.asset}`);
    } catch (error) {
      logger.error('Error handling replicated message', error);
    }
  }

  getReplicationMetrics(): {
    lagMs: number;
    healthStatus: 'healthy' | 'degraded';
  } {
    return {
      lagMs: this.replicationLagMs,
      healthStatus:
        this.replicationLagMs <= this.kafkaConfig.maxReplicationLagMs ? 'healthy' : 'degraded',
    };
  }

  isHighLag(): boolean {
    return this.replicationLagMs > this.kafkaConfig.maxReplicationLagMs;
  }

  getFeedReplicationSnapshot(): ReturnType<FeedReplicationMonitor['snapshot']> {
    return this.feedMonitor.snapshot();
  }

  async getClusterInfo(): Promise<unknown> {
    return this.kafkaClient.getClusterMetadata();
  }

  async getConsumerGroupLag(): Promise<Map<string, number>> {
    return this.kafkaClient.getConsumerGroupLag(this.kafkaConfig.consumerGroup);
  }

  private async start(): Promise<void> {
    await this.kafkaClient.connect();
    await this.kafkaClient.ensureTopics([
      { ...DEFAULT_TOPIC_CONFIG, name: this.kafkaConfig.replicationTopic },
    ]);
    this.producer = await this.kafkaClient.getProducer();
    if (this.consumerStarted) return;
    this.consumer = await this.kafkaClient.getConsumer(this.kafkaConfig.consumerGroup);
    await this.consumer.subscribe({
      topic: this.kafkaConfig.replicationTopic,
      fromBeginning: false,
    });
    await this.consumer.run({
      eachMessage: (payload) => this.handleReplicatedMessage(payload),
    });
    this.consumerStarted = true;
  }
}
