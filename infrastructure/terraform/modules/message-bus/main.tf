terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ── MSK (Managed Streaming for Kafka) Cluster ────────────────────────────────

resource "aws_msk_cluster" "main" {
  cluster_name           = "${var.project_name}-msk-${var.region_code}"
  kafka_version          = var.kafka_version
  number_of_broker_nodes = var.broker_node_count

  broker_node_group_info {
    instance_type   = var.broker_instance_type
    client_subnets  = var.private_subnet_ids
    security_groups = [aws_security_group.msk_broker.id]

    storage_info {
      ebs_storage_info {
        volume_size = var.broker_ebs_volume_size
      }
    }

    connectivity_info {
      public_access {
        type = var.enable_public_access ? "ENABLED" : "DISABLED"
      }
    }
  }

  encryption_info {
    encryption_at_rest {
      data_volume_kms_key_id = aws_kms_key.msk.arn
    }

    encryption_in_transit {
      client_broker = var.encryption_in_transit
      in_cluster    = true
    }
  }

  client_authentication {
    tls {
      enabled = true
    }
  }

  log_delivery_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk_broker_logs.name
      }

      firehose {
        enabled         = false
        delivery_stream = null
      }

      s3 {
        enabled = false
        bucket  = null
      }
    }
  }

  tags = var.tags
}

# ── MSK Cluster Encryption Key ────────────────────────────────────────────────

resource "aws_kms_key" "msk" {
  description             = "KMS key for MSK encryption at rest (${var.region_code})"
  deletion_window_in_days = 10
  enable_key_rotation     = true

  tags = merge(var.tags, { Name = "${var.project_name}-msk-key-${var.region_code}" })
}

resource "aws_kms_alias" "msk" {
  name          = "alias/${var.project_name}-msk-${var.region_code}"
  target_key_id = aws_kms_key.msk.key_id
}

# ── Security Group for MSK Brokers ────────────────────────────────────────────

resource "aws_security_group" "msk_broker" {
  name        = "${var.project_name}-msk-broker-${var.region_code}"
  description = "Security group for MSK broker nodes"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.project_name}-msk-broker-sg-${var.region_code}" })
}

# Intra-broker communication
resource "aws_security_group_rule" "msk_intra_broker" {
  type              = "ingress"
  from_port         = 9092
  to_port           = 9094
  protocol          = "tcp"
  security_group_id = aws_security_group.msk_broker.id
  self              = true
}

# Client access (internal)
resource "aws_security_group_rule" "msk_client_plaintext" {
  type              = "ingress"
  from_port         = 9092
  to_port           = 9092
  protocol          = "tcp"
  security_group_id = aws_security_group.msk_broker.id
  cidr_blocks       = var.allowed_client_cidrs
}

resource "aws_security_group_rule" "msk_client_tls" {
  type              = "ingress"
  from_port         = 9094
  to_port           = 9094
  protocol          = "tcp"
  security_group_id = aws_security_group.msk_broker.id
  cidr_blocks       = var.allowed_client_cidrs
}

# Zookeeper ports
resource "aws_security_group_rule" "msk_zookeeper" {
  type              = "ingress"
  from_port         = 2181
  to_port           = 2181
  protocol          = "tcp"
  security_group_id = aws_security_group.msk_broker.id
  cidr_blocks       = var.allowed_client_cidrs
}

# ── CloudWatch Log Group ───────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "msk_broker_logs" {
  name              = "/aws/msk/${var.project_name}/${var.region_code}"
  retention_in_days = var.log_retention_days

  kms_key_id = aws_kms_key.msk.arn

  tags = merge(var.tags, { Name = "${var.project_name}-msk-logs-${var.region_code}" })
}

# ── Topics Configuration ──────────────────────────────────────────────────────

locals {
  topics = {
    prices = {
      name              = var.replication_topic_name
      num_partitions    = var.topic_partitions
      replication_factor = min(var.broker_node_count, 3)
      config = {
        retention_ms           = var.topic_retention_ms
        retention_bytes        = var.topic_retention_bytes
        compression_type       = "snappy"
        min_insync_replicas    = max(1, var.broker_node_count - 1)
        segment_ms             = 86400000 # 1 day
        cleanup_policy         = "delete"
        flush_messages         = 10000
        flush_ms               = 1000
        log_cleanup_policy     = "delete"
        message_max_bytes      = 1000012
        replica_fetch_min_bytes = 1
      }
    }
    prices_replica = {
      name              = "${var.replication_topic_name}-replica"
      num_partitions    = var.topic_partitions
      replication_factor = min(var.broker_node_count, 3)
      config = {
        retention_ms           = var.topic_retention_ms
        retention_bytes        = var.topic_retention_bytes
        compression_type       = "snappy"
        min_insync_replicas    = max(1, var.broker_node_count - 1)
        segment_ms             = 86400000 # 1 day
        cleanup_policy         = "delete"
        flush_messages         = 10000
        flush_ms               = 1000
        message_max_bytes      = 1000012
        replica_fetch_min_bytes = 1
      }
    }
  }
}

# ── Replication Service Account (for MM2/MirrorMaker) ──────────────────────────

resource "aws_iam_user" "mirror_maker" {
  name = "${var.project_name}-mirror-maker-${var.region_code}"

  tags = merge(var.tags, { Name = "${var.project_name}-mirror-maker-${var.region_code}" })
}

resource "aws_iam_access_key" "mirror_maker" {
  user = aws_iam_user.mirror_maker.name
}

# IAM policy for MirrorMaker to access MSK
resource "aws_iam_policy" "mirror_maker_msk" {
  name        = "${var.project_name}-mirror-maker-msk-${var.region_code}"
  description = "IAM policy for MirrorMaker to access MSK"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kafka-cluster:Connect",
          "kafka-cluster:AlterCluster",
          "kafka-cluster:DescribeCluster"
        ]
        Resource = aws_msk_cluster.main.arn
      },
      {
        Effect = "Allow"
        Action = [
          "kafka-cluster:*Topic*",
          "kafka-cluster:WriteData",
          "kafka-cluster:ReadData"
        ]
        Resource = "${aws_msk_cluster.main.arn}:topic/*"
      },
      {
        Effect = "Allow"
        Action = [
          "kafka-cluster:AlterGroup",
          "kafka-cluster:DescribeGroup"
        ]
        Resource = "${aws_msk_cluster.main.arn}:group/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupIngress"
        ]
        Resource = aws_security_group.msk_broker.arn
      }
    ]
  })
}

resource "aws_iam_policy_attachment" "mirror_maker_msk" {
  name       = "${var.project_name}-mirror-maker-msk-attach-${var.region_code}"
  users      = [aws_iam_user.mirror_maker.name]
  policy_arn = aws_iam_policy.mirror_maker_msk.arn
}

# ── Metrics and Monitoring ────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "replication_lag" {
  name              = "/aws/replication/${var.project_name}/${var.region_code}/lag"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, { Name = "${var.project_name}-replication-lag-logs-${var.region_code}" })
}

# CloudWatch metric alarm for replication lag
resource "aws_cloudwatch_metric_alarm" "replication_lag_high" {
  alarm_name          = "${var.project_name}-replication-lag-high-${var.region_code}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ReplicationLatency"
  namespace           = "AWS/Kafka"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.replication_lag_threshold_ms
  alarm_description   = "Alert when replication lag exceeds ${var.replication_lag_threshold_ms}ms"
  alarm_actions       = var.alarm_action_arns
  treat_missing_data  = "notBreaching"

  tags = merge(var.tags, { Name = "${var.project_name}-replication-lag-alarm-${var.region_code}" })
}

# ── EventBridge Rule for Lambda-based Lag Monitoring ──────────────────────────

resource "aws_cloudwatch_event_rule" "lag_monitor_schedule" {
  name                = "${var.project_name}-lag-monitor-${var.region_code}"
  description         = "Trigger lag monitoring check every 30 seconds"
  schedule_expression = "rate(30 seconds)"

  tags = merge(var.tags, { Name = "${var.project_name}-lag-monitor-schedule-${var.region_code}" })
}

# ── Outputs ────────────────────────────────────────────────────────────────────

# MSK cluster bootstrap servers (for client connection)
# Usage: var.bootstrap_servers in application configs
resource "local_file" "bootstrap_servers" {
  filename = "${path.module}/bootstrap_servers.txt"
  content  = aws_msk_cluster.main.bootstrap_servers_tls

  depends_on = [aws_msk_cluster.main]
}

# Export the Zookeeper connection string (legacy, for Kafka CLI tools)
resource "local_file" "zookeeper_connect" {
  filename = "${path.module}/zookeeper_connect.txt"
  content  = aws_msk_cluster.main.zookeeper_connect_string

  depends_on = [aws_msk_cluster.main]
}
