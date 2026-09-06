variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "prod"
}

variable "project_name" {
  description = "Project name prefix for all resources"
  type        = string
  default     = "stellar-oracle"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets"
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24"]
}

variable "api_image" {
  description = "Docker image URI for the API service"
  type        = string
  default     = ""
}

variable "api_cpu" {
  description = "CPU units for the API ECS task (1 vCPU = 1024)"
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Memory (MiB) for the API ECS task"
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "Desired number of API task instances"
  type        = number
  default     = 2
}

variable "api_min_capacity" {
  description = "Minimum number of API task instances for auto-scaling"
  type        = number
  default     = 2
}

variable "api_max_capacity" {
  description = "Maximum number of API task instances for auto-scaling"
  type        = number
  default     = 10
}

variable "aggregator_image" {
  description = "Docker image URI for the aggregator service"
  type        = string
  default     = ""
}

variable "aggregator_cpu" {
  description = "CPU units for the aggregator ECS task"
  type        = number
  default     = 256
}

variable "aggregator_memory" {
  description = "Memory (MiB) for the aggregator ECS task"
  type        = number
  default     = 512
}

variable "aggregator_desired_count" {
  description = "Desired number of aggregator task instances"
  type        = number
  default     = 2
}

variable "aggregator_min_capacity" {
  description = "Minimum number of aggregator task instances for auto-scaling"
  type        = number
  default     = 1
}

variable "aggregator_max_capacity" {
  description = "Maximum number of aggregator task instances for auto-scaling"
  type        = number
  default     = 6
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.medium"
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "oracle_db"
}

variable "db_username" {
  description = "PostgreSQL master username"
  type        = string
  default     = "oracle_admin"
  sensitive   = true
}

variable "db_password" {
  description = "PostgreSQL master password"
  type        = string
  sensitive   = true
}

variable "db_allocated_storage" {
  description = "Allocated storage in GiB for RDS"
  type        = number
  default     = 50
}

variable "db_max_allocated_storage" {
  description = "Maximum storage autoscaling limit in GiB"
  type        = number
  default     = 200
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS on the load balancer"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default = {
    Project   = "stellar-oracle"
    ManagedBy = "terraform"
  }
}
