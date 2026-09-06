import { Producer, Consumer, EachMessagePayload } from 'kafkajs';
import { AggregatedPrice } from '../infrastructure/types';
import { LwwPriceRegister, RegionPriceRecord } from './price-crdt';
import { KafkaBusClient, DEFAULT_TOPIC_CONFIG } from './kafka-bus-client';
import { logger } from '../observability/logger';
import { config } from '../infrastructure/config';

export interface KafkaReplicatorConfig {
  regionId: string;
  kafkaBrokers: string[];
  replicationTopic: string;
  consumerGroup: string;
  maxReplicationLagMs: number;
  publishInterval: number;
}

/**
 * KafkaReplicator integrates the Kafka bus with the CRDT-based price register.
 * It publishes local prices to the Kafka topic and consumes replicated prices
 * from remote regions.
 */
export class KafkaReplicator {
  private kafkaClient: KafkaBusClient;
  private register = new LwwPriceRegister();
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private publishInterval: NodeJS.Timeout | null = null;
  private replicationLagMs = 0;
  private consumerLagMap = new Map<string, number>();

  constructor(private kafkaConfig: KafkaReplicatorConfig) {
    this.kafkaClient = new KafkaBusClient({
      brokers: kafkaConfig.kafkaBrokers,
      clientId: `${kafkaConfig.regionId}-price-replicator`,
      sslEnabled: config.soroban.rpcUrl.includes('https'),
      saslEnabled: false, // Adjust based on your MSK authentication
    });
  }

  /**
   * Initialize Kafka connection and start replication
   */
  async initialize(): Promise<void> {
    try {
      // Connect to Kafka cluster
      await this.kafkaClient.connect();

      // Ensure replication topic exists
      await this.kafkaClient.ensureTopics([
        {
          ...DEFAULT_TOPIC_CONFIG,
          name: this.kafkaConfig.replicationTopic,
        },
      ]);

      // Initialize producer and consumer
      this.producer = await this.kafkaClient.getProducer();
      this.consumer = await this.kafkaClient.getConsumer(this.kafkaConfig.consumerGroup);

      // Subscribe to replicated prices from other regions
      await this.consumer.subscribe({
        topic: this.kafkaConfig.replicationTopic,
        fromBeginning: false,
      });

      // Start consuming messages
      await this.consumer.run({
        eachMessage: this.handleReplicatedMessage.bind(this),
      });

      // Start publishing local prices periodically
      this.startPublishLoop();

      logger.info(
        `KafkaReplicator initialized for region ${this.kafkaConfig.regionId}`
      );
    } catch (error) {
      logger.error('Failed to initialize KafkaReplicator', error);
      throw error;
    }
  }

  /**
   * Shutdown the replicator
   */
  async shutdown(): Promise<void> {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
      this.publishInterval = null;
    }

    await this.kafkaClient.disconnect();
    logger.info('KafkaReplicator shut down');
  }

  /**
   * Merge local prices into the CRDT register and flag for publishing
   */
  mergeLocalPrices(prices: AggregatedPrice[]): void {
    this.register.mergeLocal(this.kafkaConfig.regionId, prices);
  }

  /**
   * Get the latest prices from all regions
   */
  getLatestPrices(): RegionPriceRecord[] {
    return this.register.latestAll();
  }

  /**
   * Start publishing local prices at regular intervals
   */
  private startPublishLoop(): void {
    this.publishInterval = setInterval(async () => {
      await this.publishLocalPrices();
    }, this.kafkaConfig.publishInterval);
  }

  /**
   * Publish local aggregated prices to Kafka topic
   */
  private async publishLocalPrices(): Promise<void> {
    if (!this.producer) {
      return;
    }

    try {
      const prices = this.register.latestAll();

      if (prices.length === 0) {
        return;
      }

      const messages = prices.map((price) => ({
        key: `${this.kafkaConfig.regionId}:${price.asset}`,
        value: JSON.stringify({
          region: this.kafkaConfig.regionId,
          asset: price.asset,
          price: price.price.toString(),
          decimals: price.decimals,
          source: 'local',
          timestamp: price.timestamp,
          wallClock: Date.now(),
        }),
        timestamp: Date.now().toString(),
      }));

      await this.producer.send({
        topic: this.kafkaConfig.replicationTopic,
        messages,
        compression: 1, // Snappy compression
        timeout: 30000,
      });
    } catch (error) {
      logger.error('Failed to publish local prices', error);
    }
  }

  /**
   * Handle incoming replicated messages from other regions
   */
  private async handleReplicatedMessage(payload: EachMessagePayload): Promise<void> {
    try {
      const { topic, message } = payload;

      if (!message.value) {
        return;
      }

      const priceRecord = JSON.parse(message.value.toString());

      // Track replication lag
      const messageAge = Date.now() - parseInt(message.timestamp || '0');
      this.replicationLagMs = Math.max(this.replicationLagMs, messageAge);

      // Merge remote price into CRDT
      this.register.merge({
        region: priceRecord.region,
        asset: priceRecord.asset,
        price: BigInt(priceRecord.price),
        decimals: priceRecord.decimals,
        timestamp: priceRecord.timestamp,
        receivedAt: Date.now(),
        source: 'remote',
      });

      // Track per-topic consumer lag
      if (!this.consumerLagMap.has(topic)) {
        this.consumerLagMap.set(topic, 0);
      }

      logger.debug(
        `Replicated price: region=${priceRecord.region} asset=${priceRecord.asset} lag=${messageAge}ms`
      );
    } catch (error) {
      logger.error('Error handling replicated message', error);
    }
  }

  /**
   * Get current replication lag metrics
   */
  getReplicationMetrics(): {
    lagMs: number;
    consumerLags: Map<string, number>;
    healthStatus: 'healthy' | 'degraded' | 'unhealthy';
  } {
    const healthStatus =
      this.replicationLagMs <= this.kafkaConfig.maxReplicationLagMs
        ? 'healthy'
        : 'degraded';

    return {
      lagMs: this.replicationLagMs,
      consumerLags: this.consumerLagMap,
      healthStatus,
    };
  }

  /**
   * Check if replication is experiencing high lag
   */
  isHighLag(): boolean {
    return this.replicationLagMs > this.kafkaConfig.maxReplicationLagMs;
  }

  /**
   * Get detailed cluster information for monitoring
   */
  async getClusterInfo(): Promise<any> {
    return this.kafkaClient.getClusterMetadata();
  }

  /**
   * Get consumer group lag details
   */
  async getConsumerGroupLag(): Promise<Map<string, number>> {
    return this.kafkaClient.getConsumerGroupLag(this.kafkaConfig.consumerGroup);
  }
}
