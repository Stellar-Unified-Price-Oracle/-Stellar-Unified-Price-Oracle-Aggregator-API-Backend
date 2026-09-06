# Message Bus (Kafka/MSK) Terraform Module

This module provisions AWS Managed Streaming for Kafka (MSK) clusters in each region to enable cross-region price replication for the Stellar price oracle.

## Architecture

- **MSK Cluster**: Highly available Kafka cluster across 3 AZs with at least 3 broker nodes per region
- **Encryption**: KMS encryption at rest, TLS encryption in transit
- **Topics**:
  - `stellar-oracle-prices`: Primary topic for local aggregated prices
  - `stellar-oracle-prices-replica`: Mirror topic for replicated prices from other regions
- **MirrorMaker 2**: Cross-region asynchronous replication via standalone MirrorMaker instances
- **Monitoring**: CloudWatch metrics and alarms for replication lag

## Usage

### Single-Region Deployment

```hcl
module "message_bus_east" {
  source = "./modules/message-bus"

  aws_region          = "us-east-1"
  region_code         = "ue1"
  project_name        = "stellar-oracle"
  vpc_id              = aws_vpc.main.id
  private_subnet_ids  = aws_subnet.private[*].id
  allowed_client_cidrs = ["10.0.0.0/16"]

  broker_node_count      = 3
  broker_instance_type   = "kafka.m5.large"
  broker_ebs_volume_size = 100

  kafka_version           = "3.5.1"
  encryption_in_transit   = "TLS_PLAINTEXT"
  replication_topic_name  = "stellar-oracle-prices"
  topic_partitions        = 3
  topic_retention_ms      = 604800000 # 7 days
  
  replication_lag_threshold_ms = 5000

  tags = {
    Project   = "stellar-oracle"
    ManagedBy = "terraform"
    Region    = "us-east-1"
  }
}
```

### Multi-Region Deployment

For cross-region replication, deploy the module in each region and configure MirrorMaker 2 instances to connect the clusters.

## Topic Configuration

### `stellar-oracle-prices` (Primary)

- **Partitions**: 3 (one per broker for even distribution)
- **Replication Factor**: 3 (for high availability)
- **Min ISR**: 2 (minimum in-sync replicas)
- **Retention**: 7 days (604800000ms)
- **Compression**: Snappy
- **Segment**: 1 day

### `stellar-oracle-prices-replica` (Mirror)

Same configuration as primary; used by consumers in other regions to track remote prices.

## Replication Flow

```
Region A Aggregator
    ↓
    └→ Publishes to stellar-oracle-prices (Region A)
           ↓
           └→ MirrorMaker 2 (Region A → Region B)
                  ↓
                  └→ stellar-oracle-prices-replica (Region B)
                         ↓
                         └→ Region B Consumer merges into CRDT
```

## Monitoring and Alerting

### CloudWatch Metrics

The module creates alarms for:
- **ReplicationLatency**: Lag between source and target topics

### Custom Lambda-based Lag Monitoring

Implement a Lambda function triggered by `lag_monitor_schedule` EventBridge rule to:
1. Query consumer group lag via Kafka API
2. Push custom CloudWatch metrics for per-topic-partition lag
3. Trigger SNS notifications if lag exceeds `REGION_MAX_REPLICATION_LAG_MS`

Example metric publishing (Lambda):

```python
import boto3
import json

cloudwatch = boto3.client('cloudwatch')
kafka = boto3.client('kafka')

def lambda_handler(event, context):
    cluster_arn = event['cluster_arn']
    
    # Get consumer group metrics via AdminClient
    lag = get_consumer_group_lag(cluster_arn)
    
    cloudwatch.put_metric_data(
        Namespace='StellarOracle/Replication',
        MetricData=[
            {
                'MetricName': 'ConsumerGroupLag',
                'Value': lag,
                'Unit': 'Milliseconds',
                'Dimensions': [
                    {'Name': 'Region', 'Value': 'us-east-1'},
                    {'Name': 'ConsumerGroup', 'Value': 'stellar-price-replicator'},
                    {'Name': 'Topic', 'Value': 'stellar-oracle-prices-replica'}
                ]
            }
        ]
    )
    
    return {'statusCode': 200, 'body': json.dumps('Lag published')}
```

## Security

- **Encryption at Rest**: KMS-managed keys
- **Encryption in Transit**: TLS on port 9094
- **IAM**: MirrorMaker service account with minimal MSK permissions
- **Network**: Security group restricts access to specified CIDR blocks
- **Public Access**: Disabled by default

## Cross-Region MirrorMaker 2 Setup

### Deploy MirrorMaker 2 (Standalone)

On an EC2 instance or ECS task in each region:

```bash
# Download MirrorMaker 2
wget https://archive.apache.org/dist/kafka/3.5.1/kafka_2.13-3.5.1.tgz
tar xzf kafka_2.13-3.5.1.tgz

# Create mm2.properties configuration
cat > mm2.properties << EOF
clusters = source, target
source.bootstrap.servers = <source-region-bootstrap-servers>
target.bootstrap.servers = <target-region-bootstrap-servers>

source.security.protocol = SSL
target.security.protocol = SSL

# Topics to replicate (regex)
source->target.enabled = true
source->target.topics = stellar-oracle.*

# Consumer groups to replicate
source->target.groups = stellar-price-replicator

# Sync source offset to target
source->target.sync.group.offsets.enabled = true
source->target.sync.group.offsets.interval.seconds = 60

# Emit heartbeat topics
source->target.emit.heartbeats.enabled = true
source->target.heartbeats.topic.replication.factor = 2

# Emit checkpoint offsets
source->target.emit.checkpoints.enabled = true
source->target.emit.checkpoints.interval.seconds = 60
source->target.checkpoint.interval.seconds = 60
source->target.checkpoint.topic.replication.factor = 2

# Consumer group to track MirrorMaker offsets
source->target.group.id = mirrormaker-cluster

# MirrorMaker metrics reporter
metric.reporters = org.apache.kafka.common.metrics.JmxReporter
EOF

# Start MirrorMaker 2
./bin/connect-mirror-maker.sh mm2.properties
```

### Topic and Consumer Group Replication

MirrorMaker 2 automatically:
- Creates mirror topics with `-replica` suffix
- Syncs consumer group offsets every 60 seconds
- Emits heartbeats and checkpoints for consistency tracking

## Outputs

The module exports:

- `bootstrap_servers_tls`: TLS endpoints for client applications
- `bootstrap_servers_plaintext`: Plaintext endpoints (internal only)
- `security_group_id`: For allowing additional security group ingress
- `mirror_maker_*`: IAM credentials and user for MirrorMaker

## Costs

### Estimated Monthly Cost (3 brokers, kafka.m5.large)

- MSK brokers: ~$200/month (3 × $0.095/hour)
- EBS storage: ~$15/month (100 GiB)
- Data transfer (cross-region): ~$0.02/GB ingress + egress
- **Total per region**: ~$220/month + data transfer

For 3 regions with bidirectional replication, budget ~$700–1000/month depending on message volume.

## Troubleshooting

### High Replication Lag

1. Check MirrorMaker 2 logs for connection errors
2. Verify security groups allow broker communication
3. Monitor broker CPU and network utilization
4. Increase consumer parallelism in mm2.properties:
   ```
   source->target.tasks.max = 2
   ```

### Topic Does Not Appear in Target Cluster

1. Verify `source->target.topics` regex in mm2.properties
2. Check MirrorMaker 2 consumer group offsets:
   ```bash
   kafka-consumer-groups.sh \
     --bootstrap-server <target> \
     --describe \
     --group mirrormaker-cluster
   ```

### Consumer Group Offset Sync Lag

Increase `source->target.sync.group.offsets.interval.seconds` to push offsets more frequently (trade-off: increases replication overhead).
