variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "region_code" {
  description = "Short code for the region"
  type        = string
}

variable "project_name" {
  description = "Project name prefix"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the MirrorMaker instance"
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID for the MirrorMaker EC2 instance"
  type        = string
}

variable "enabled" {
  description = "Enable MirrorMaker deployment"
  type        = bool
  default     = true
}

variable "instance_type" {
  description = "EC2 instance type for MirrorMaker"
  type        = string
  default     = "t3.medium"
}

variable "source_bootstrap_servers" {
  description = "Bootstrap servers for source Kafka cluster (comma-separated)"
  type        = string
}

variable "target_bootstrap_servers" {
  description = "Bootstrap servers for target Kafka cluster (comma-separated)"
  type        = string
}

variable "source_security_protocol" {
  description = "Security protocol for source cluster (PLAINTEXT or SSL)"
  type        = string
  default     = "SSL"
}

variable "target_security_protocol" {
  description = "Security protocol for target cluster (PLAINTEXT or SSL)"
  type        = string
  default     = "SSL"
}

variable "kafka_version" {
  description = "Kafka version to download"
  type        = string
  default     = "3.5.1"
}

variable "mm2_consumer_group" {
  description = "Consumer group ID for MirrorMaker"
  type        = string
  default     = "mirrormaker-cluster"
}

variable "replication_topic_regex" {
  description = "Regex for topics to replicate"
  type        = string
  default     = "stellar-oracle.*"
}

variable "sync_offsets_interval_seconds" {
  description = "Interval to sync offsets in seconds"
  type        = number
  default     = 60
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "bastion_security_group_id" {
  description = "Optional bastion security group ID to allow SSH"
  type        = string
  default     = ""
}

variable "lag_alarm_threshold_ms" {
  description = "Lag threshold (ms) for CloudWatch alarm"
  type        = number
  default     = 5000
}

variable "alarm_action_arns" {
  description = "SNS topic ARNs for alarm actions"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
