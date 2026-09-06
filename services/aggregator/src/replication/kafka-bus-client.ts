import { Kafka, Admin, Producer, Consumer, logLevel } from 'kafkajs';
import { logger } from '../observability/logger';

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  sslEnabled: boolean;
  saslEnabled: boolean;
  saslMechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  saslUsername?: string;
  saslPassword?: string;
  requestTimeout?: number;
  connectionTimeout?: number;
  retries?: number;
  initialRetryTime?: number;
  maxRetryTime?: number;
}

export interface TopicConfig {
  name: string;
  numPartitions: number;
  replicationFactor: number;
  configEntries?: Record<string, string>;
}

export const DEFAULT_TOPIC_CONFIG: TopicConfig = {
  name: 'stellar-oracle-prices',
  numPartitions: 3,
  replicationFactor: 3,
  configEntries: {
    'retention.ms': '604800000', // 7 days
    'retention.bytes': '0', // infinite (unless set)
    'compression.type': 'snappy',
    'min.insync.replicas': '2',
    'segment.ms': '86400000', // 1 day
    'cleanup.policy': 'delete',
    'flush.messages': '10000',
    'flush.ms': '1000',
    'message.max.bytes': '1000012',
    'replica.fetch.min.bytes': '1',
  },
};

/**
 * KafkaBusClient manages connection to the Kafka cluster and provides
 * producer/consumer abstractions for cross-region price replication.
 */
export class KafkaBusClient {
  private kafka: Kafka;
  private admin: Admin | null = null;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private connected = false;

  constructor(private kafkaConfig: KafkaConfig) {
    const cfg = {
      clientId: this.kafkaConfig.clientId,
      brokers: this.kafkaConfig.brokers,
      logLevel: logLevel.ERROR,
      connectionTimeout: this.kafkaConfig.connectionTimeout || 10000,
      requestTimeout: this.kafkaConfig.requestTimeout || 30000,
      retry: {
        initialRetryTime: this.kafkaConfig.initialRetryTime || 100,
        retries: this.kafkaConfig.retries || 8,
        maxRetryTime: this.kafkaConfig.maxRetryTime || 30000,
      },
    };

    if (this.kafkaConfig.sslEnabled) {
      (cfg as any).ssl = true;
    }

    if (this.kafkaConfig.saslEnabled) {
      (cfg as any).sasl = {
        mechanism: this.kafkaConfig.saslMechanism || 'plain',
        username: this.kafkaConfig.saslUsername,
        password: this.kafkaConfig.saslPassword,
      };
    }

    this.kafka = new Kafka(cfg);
  }

  /**
   * Connect to Kafka and verify cluster is reachable
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      this.admin = this.kafka.admin();
      await this.admin.connect();
      
      const cluster = await this.admin.fetchTopicMetadata();
      logger.info(`Connected to Kafka cluster with ${cluster.topics.length} topics`);
      
      this.connected = true;
    } catch (error) {
      logger.error('Failed to connect to Kafka', error);
      throw error;
    }
  }

  /**
   * Disconnect from Kafka
   */
  async disconnect(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = null;
    }
    if (this.admin) {
      await this.admin.disconnect();
      this.admin = null;
    }
    this.connected = false;
  }

  /**
   * Create or update topics with the provided configuration
   */
  async ensureTopics(topics: TopicConfig[]): Promise<void> {
    if (!this.admin) {
      throw new Error('Not connected to Kafka');
    }

    const topicConfigs = topics.map((topic) => ({
      topic: topic.name,
      numPartitions: topic.numPartitions,
      replicationFactor: topic.replicationFactor,
      configEntries: Object.entries(topic.configEntries || {}).map(([name, value]) => ({
        name,
        value,
      })),
    }));

    try {
      await this.admin.createTopics({
        topics: topicConfigs,
        validateOnly: false,
        waitForLeaders: true,
      });
      
      logger.info(`Created or verified ${topics.length} topics`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        logger.info('Topics already exist, skipping creation');
      } else {
        logger.error('Failed to create topics', error);
        throw error;
      }
    }
  }

  /**
   * Get or create a producer for publishing messages
   */
  async getProducer(): Promise<Producer> {
    if (!this.connected) {
      throw new Error('Not connected to Kafka');
    }

    if (this.producer) {
      return this.producer;
    }

    this.producer = this.kafka.producer({
      idempotent: true, // Ensure exactly-once semantics
      maxInFlightRequests: 5,
      transactionTimeout: 60000,
    });

    await this.producer.connect();
    logger.info('Producer connected');

    return this.producer;
  }

  /**
   * Get or create a consumer for subscribing to messages
   */
  async getConsumer(groupId: string): Promise<Consumer> {
    if (!this.connected) {
      throw new Error('Not connected to Kafka');
    }

    if (this.consumer) {
      return this.consumer;
    }

    this.consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 30000,
      rebalanceTimeout: 60000,
      heartbeatInterval: 3000,
    });

    await this.consumer.connect();
    logger.info(`Consumer connected to group ${groupId}`);

    return this.consumer;
  }

  /**
   * Get broker and topic metadata for debugging/monitoring
   */
  async getClusterMetadata(): Promise<any> {
    if (!this.admin) {
      throw new Error('Not connected to Kafka');
    }

    const metadata = await this.admin.fetchTopicMetadata();
    const cluster = await this.admin.describeCluster();

    return {
      cluster: {
        brokers: cluster.brokers.length,
        controller: cluster.controller,
        brokerList: cluster.brokers.map((b) => ({
          id: b.nodeId,
          host: b.host,
          port: b.port,
        })),
      },
      topics: metadata.topics.map((t) => ({
        name: t.name,
        partitions: t.partitions.length,
        isr: t.partitions.map((p) => p.isr?.length || 0),
      })),
    };
  }

  /**
   * Check consumer group lag
   */
  async getConsumerGroupLag(groupId: string): Promise<Map<string, number>> {
    if (!this.admin) {
      throw new Error('Not connected to Kafka');
    }

    try {
      const groups = await this.admin.describeGroups([groupId]);
      const lag = new Map<string, number>();

      for (const group of groups.groups) {
        if (group.state === 'Stable') {
          const topicOffsets = await this.admin.fetchOffsets({ groupId });
          for (const topicOffsetData of topicOffsets) {
            const topic = topicOffsetData.topic;
            const totalLag = topicOffsetData.partitions.reduce((sum: number, offset: any) => {
              return sum + (parseInt(offset.high) - parseInt(offset.offset));
            }, 0);
            lag.set(topic, totalLag);
          }
        }
      }

      return lag;
    } catch (error) {
      logger.error('Failed to fetch consumer group lag', error);
      throw error;
    }
  }
}
