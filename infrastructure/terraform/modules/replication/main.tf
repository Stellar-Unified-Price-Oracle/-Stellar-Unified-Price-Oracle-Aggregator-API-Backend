# ── Variables ─────────────────────────────────────────────────────────────────
#
# Usage: instantiate this module once per target region, passing the appropriate
# provider alias.  Example from a root module:
#
#   provider "aws" { alias = "eu_west_1"; region = "eu-west-1" }
#   provider "aws" { alias = "ap_southeast_1"; region = "ap-southeast-1" }
#
#   module "replication_eu" {
#     source          = "./modules/replication"
#     project_name    = var.project_name
#     source_region   = "us-east-1"
#     target_region   = "eu-west-1"
#     db_identifier   = module.database.db_identifier
#     providers       = { aws = aws.eu_west_1 }
#   }

variable "project_name" {
  description = "Project name prefix for all resources"
  type        = string
}

variable "source_region" {
  description = "AWS region where the primary RDS instance lives"
  type        = string
}

variable "target_region" {
  description = "AWS region to replicate backups into (must match the provider region)"
  type        = string
}

variable "target_regions" {
  description = "Legacy list variable kept for compatibility — only target_region is used"
  type        = list(string)
  default     = []
}

variable "db_identifier" {
  description = "RDS instance identifier in the source region"
  type        = string
}

# ── Current account ───────────────────────────────────────────────────────────

data "aws_caller_identity" "current" {}

# ── RDS Automated Backups Replication ─────────────────────────────────────────
# Replicates automated backups from source_region into the region of the
# configured provider (target_region).

resource "aws_db_instance_automated_backups_replication" "replica" {
  source_db_instance_arn = "arn:aws:rds:${var.source_region}:${data.aws_caller_identity.current.account_id}:db:${var.db_identifier}"
  retention_period       = 7
}

# ── Kinesis Stream for Price Events ──────────────────────────────────────────
# Created in the target region so downstream consumers in that region can read.

resource "aws_kinesis_stream" "price_events" {
  name             = "${var.project_name}-price-events"
  shard_count      = 2
  retention_period = 24

  stream_mode_details {
    stream_mode = "PROVISIONED"
  }

  tags = {
    Name    = "${var.project_name}-price-events"
    Project = var.project_name
  }
}

# ── IAM Role for Cross-Region Replication ────────────────────────────────────

resource "aws_iam_role" "replication" {
  name = "${var.project_name}-replication-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "KinesisReplication"
        Effect = "Allow"
        Principal = {
          Service = "kinesis.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      },
      {
        Sid    = "RDSReplication"
        Effect = "Allow"
        Principal = {
          Service = "rds.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "replication" {
  name = "${var.project_name}-replication-policy"
  role = aws_iam_role.replication.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "KinesisWrite"
        Effect = "Allow"
        Action = [
          "kinesis:PutRecord",
          "kinesis:PutRecords",
          "kinesis:DescribeStream",
          "kinesis:GetShardIterator",
          "kinesis:GetRecords",
          "kinesis:ListShards"
        ]
        Resource = aws_kinesis_stream.price_events.arn
      },
      {
        Sid    = "RDSBackupReplication"
        Effect = "Allow"
        Action = [
          "rds:StartDBInstanceAutomatedBackupsReplication",
          "rds:StopDBInstanceAutomatedBackupsReplication",
          "rds:DescribeDBInstanceAutomatedBackups"
        ]
        Resource = "*"
      },
      {
        Sid    = "KMSForRDS"
        Effect = "Allow"
        Action = [
          "kms:CreateGrant",
          "kms:DescribeKey"
        ]
        Resource = "*"
      }
    ]
  })
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "kinesis_stream_arn" {
  description = "ARN of the Kinesis price-events stream in the target region"
  value       = aws_kinesis_stream.price_events.arn
}

output "replication_enabled" {
  description = "Whether cross-region backup replication is configured"
  value       = true
}

output "replication_role_arn" {
  description = "ARN of the IAM role used for cross-region replication"
  value       = aws_iam_role.replication.arn
}
