clusters = source, target

# Source cluster (e.g., us-east-1)
source.bootstrap.servers = ${source_bootstrap_servers}
source.security.protocol = ${source_security_protocol}
source.sasl.mechanism = PLAIN
source.sasl.jaas.config = org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="admin-secret";

# Target cluster (e.g., eu-west-1)
target.bootstrap.servers = ${target_bootstrap_servers}
target.security.protocol = ${target_security_protocol}
target.sasl.mechanism = PLAIN
target.sasl.jaas.config = org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="admin-secret";

# Replication flows
source->target.enabled = true
target->source.enabled = false

# Topics to replicate (regex pattern)
source->target.topics = ${replication_topic_regex}
source->target.groups = stellar-price-replicator

# Consumer configuration
source->target.consumer.max.poll.records = 500
source->target.consumer.max.poll.interval.ms = 300000

# Producer configuration
source->target.producer.compression.type = snappy
source->target.producer.batch.size = 32768
source->target.producer.linger.ms = 100

# Sync consumer offsets to target
source->target.sync.group.offsets.enabled = true
source->target.sync.group.offsets.interval.seconds = ${sync_offsets_interval}
source->target.sync.group.offsets.topic.replication.factor = 2

# Emit heartbeats for checkpointing
source->target.emit.heartbeats.enabled = true
source->target.heartbeats.topic.num.partitions = 1
source->target.heartbeats.topic.replication.factor = 2
source->target.heartbeats.interval.seconds = 5

# Emit checkpoint offsets
source->target.emit.checkpoints.enabled = true
source->target.emit.checkpoints.interval.seconds = 60
source->target.checkpoints.topic.num.partitions = 1
source->target.checkpoints.topic.replication.factor = 2
source->target.checkpoint.interval.seconds = 60

# MirrorMaker internal group
source->target.group.id = ${mm2_consumer_group}

# Task configuration (parallelism)
source->target.tasks.max = 2

# Metrics and offsets
source->target.offset.lag.max = 100000

# Metrics reporter
metric.reporters = org.apache.kafka.common.metrics.JmxReporter

# Internal topic naming
source->target.checkpoint.topic.prefix = __mirrormaker
source->target.heartbeat.topic.prefix = __mirrormaker
source->target.offset.syncs.topic.prefix = __mirrormaker
source->target.offset.syncs.topics.config = true
