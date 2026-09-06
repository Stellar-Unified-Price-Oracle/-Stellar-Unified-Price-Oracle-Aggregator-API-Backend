output "cluster_arn" {
  description = "ARN of the MSK cluster"
  value       = aws_msk_cluster.main.arn
}

output "cluster_name" {
  description = "Name of the MSK cluster"
  value       = aws_msk_cluster.main.cluster_name
}

output "bootstrap_servers_plaintext" {
  description = "Plaintext bootstrap servers (port 9092)"
  value       = aws_msk_cluster.main.bootstrap_servers
}

output "bootstrap_servers_tls" {
  description = "TLS bootstrap servers (port 9094)"
  value       = aws_msk_cluster.main.bootstrap_servers_tls
}

output "zookeeper_connect_string" {
  description = "Zookeeper connection string"
  value       = aws_msk_cluster.main.zookeeper_connect_string
}

output "security_group_id" {
  description = "Security group ID for MSK brokers"
  value       = aws_security_group.msk_broker.id
}

output "kms_key_id" {
  description = "KMS key ID for MSK encryption"
  value       = aws_kms_key.msk.key_id
}

output "kms_key_arn" {
  description = "KMS key ARN for MSK encryption"
  value       = aws_kms_key.msk.arn
}

output "cloudwatch_log_group_name" {
  description = "CloudWatch log group name for broker logs"
  value       = aws_cloudwatch_log_group.msk_broker_logs.name
}

output "mirror_maker_user_name" {
  description = "IAM username for MirrorMaker replication"
  value       = aws_iam_user.mirror_maker.name
}

output "mirror_maker_access_key_id" {
  description = "Access key ID for MirrorMaker"
  value       = aws_iam_access_key.mirror_maker.id
  sensitive   = true
}

output "mirror_maker_secret_access_key" {
  description = "Secret access key for MirrorMaker"
  value       = aws_iam_access_key.mirror_maker.secret
  sensitive   = true
}

output "lag_monitoring_log_group_name" {
  description = "CloudWatch log group name for replication lag monitoring"
  value       = aws_cloudwatch_log_group.replication_lag.name
}

output "replication_topic_config" {
  description = "Configuration for the replication topic"
  value = {
    name              = local.topics.prices.name
    partitions        = local.topics.prices.num_partitions
    replication_factor = local.topics.prices.replication_factor
    retention_ms      = local.topics.prices.config.retention_ms
  }
}
