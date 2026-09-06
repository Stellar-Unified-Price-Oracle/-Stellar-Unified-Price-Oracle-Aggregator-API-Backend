variable "aws_region" {
  description = "AWS region for the Kafka cluster"
  type        = string
}

variable "region_code" {
  description = "Short code for the region (e.g., ue1 for us-east-1)"
  type        = string
}

variable "project_name" {
  description = "Project name prefix"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where the MSK cluster will be deployed"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for MSK broker placement"
  type        = list(string)
}

variable "allowed_client_cidrs" {
  description = "CIDR blocks allowed to connect to Kafka brokers"
  type        = list(string)
}

variable "kafka_version" {
  description = "Kafka version"
  type        = string
  default     = "3.5.1"
}

variable "broker_node_count" {
  description = "Number of broker nodes in the cluster"
  type        = number
  default     = 3
}

variable "broker_instance_type" {
  description = "EC2 instance type for broker nodes"
  type        = string
  default     = "kafka.m5.large"
}

variable "broker_ebs_volume_size" {
  description = "EBS volume size (GiB) for each broker"
  type        = number
  default     = 100
}

variable "enable_public_access" {
  description = "Enable public access to the MSK cluster (NOT recommended for production)"
  type        = bool
  default     = false
}

variable "encryption_in_transit" {
  description = "TLS encryption policy for client broker communication"
  type        = string
  default     = "TLS_PLAINTEXT"
  validation {
    condition     = contains(["PLAINTEXT", "TLS", "TLS_PLAINTEXT"], var.encryption_in_transit)
    error_message = "encryption_in_transit must be one of: PLAINTEXT, TLS, TLS_PLAINTEXT"
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "replication_topic_name" {
  description = "Topic name for cross-region price replication"
  type        = string
  default     = "stellar-oracle-prices"
}

variable "topic_partitions" {
  description = "Number of partitions for the replication topic (should match broker_node_count for even distribution)"
  type        = number
  default     = 3
}

variable "topic_retention_ms" {
  description = "Retention time in milliseconds (0 = infinite)"
  type        = number
  default     = 604800000 # 7 days
}

variable "topic_retention_bytes" {
  description = "Retention size in bytes (0 = infinite)"
  type        = number
  default     = 0
}

variable "replication_lag_threshold_ms" {
  description = "Threshold in milliseconds for replication lag alarm"
  type        = number
  default     = 5000 # 5 seconds
}

variable "alarm_action_arns" {
  description = "ARNs of SNS topics or other alarm actions for high lag alerts"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default     = {}
}
