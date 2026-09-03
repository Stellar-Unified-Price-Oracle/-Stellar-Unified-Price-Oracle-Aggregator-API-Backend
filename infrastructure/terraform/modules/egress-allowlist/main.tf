# infrastructure/terraform/modules/egress-allowlist/main.tf
#
# AWS Security Group that allows outbound HTTPS only to the oracle source
# IP blocks.  Attach this SG to the aggregator ECS task / EKS node group
# in the mainnet environment.
#
# The "deny-all-other-egress" rule is enforced by the absence of a catch-all
# 0.0.0.0/0 outbound rule.  AWS SGs are default-deny for egress when you
# explicitly revoke the default outbound rule, which this module does.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "vpc_id" {
  description = "VPC ID to attach the security group to"
  type        = string
}

variable "project_name" {
  description = "Project name prefix"
  type        = string
  default     = "stellar-oracle"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
}

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Oracle source FQDN → IP block mapping (refreshed 2026-09-03).
# Re-run scripts/resolve-oracle-ips.sh and update before each mainnet deploy.
# ---------------------------------------------------------------------------
locals {
  oracle_egress_cidrs = {
    "chainlink-cryptocompare" = "185.199.108.0/22"
    "redstone-vercel"         = "76.76.21.0/24"
    "band-gcp"                = "34.87.0.0/16"
    "reflector-cloudflare"    = "104.21.0.0/16"
    "stellar-aws"             = "54.80.0.0/16"
  }

  # SDF uses multiple AWS ranges; add a secondary block for resilience.
  stellar_secondary_cidrs = [
    "52.0.0.0/11",   # AWS us-east-1 broader range
    "34.192.0.0/12", # AWS us-east-1 broader range
  ]
}

# ---------------------------------------------------------------------------
# Aggregator egress security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "aggregator_egress" {
  name        = "${var.project_name}-${var.environment}-aggregator-egress"
  description = "Aggregator outbound HTTPS restricted to oracle source allowlist"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name        = "${var.project_name}-${var.environment}-aggregator-egress"
    Environment = var.environment
    Purpose     = "oracle-egress-allowlist"
  })
}

# Oracle source egress rules — one per FQDN block
resource "aws_vpc_security_group_egress_rule" "oracle_https" {
  for_each = local.oracle_egress_cidrs

  security_group_id = aws_security_group.aggregator_egress.id
  description       = "HTTPS egress to oracle source: ${each.key}"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value

  tags = {
    Name    = "${var.project_name}-egress-${each.key}"
    Purpose = "oracle-egress"
  }
}

# Additional Stellar AWS ranges (Soroban RPC secondary IPs)
resource "aws_vpc_security_group_egress_rule" "stellar_secondary" {
  count = length(local.stellar_secondary_cidrs)

  security_group_id = aws_security_group.aggregator_egress.id
  description       = "HTTPS egress to Stellar/SDF secondary AWS range ${count.index + 1}"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = local.stellar_secondary_cidrs[count.index]

  tags = {
    Name    = "${var.project_name}-egress-stellar-secondary-${count.index + 1}"
    Purpose = "oracle-egress"
  }
}

# Internal VPC egress — allow the aggregator to reach the DB and Redis
resource "aws_vpc_security_group_egress_rule" "internal_postgres" {
  security_group_id = aws_security_group.aggregator_egress.id
  description       = "Internal egress: PostgreSQL / TimescaleDB"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = data.aws_vpc.selected.cidr_block

  tags = { Name = "${var.project_name}-egress-postgres" }
}

resource "aws_vpc_security_group_egress_rule" "internal_redis" {
  security_group_id = aws_security_group.aggregator_egress.id
  description       = "Internal egress: Redis"
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6380
  cidr_ipv4         = data.aws_vpc.selected.cidr_block

  tags = { Name = "${var.project_name}-egress-redis" }
}

# DNS resolution (AWS-provided resolver)
resource "aws_vpc_security_group_egress_rule" "dns_udp" {
  security_group_id = aws_security_group.aggregator_egress.id
  description       = "DNS UDP to AWS resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = "169.254.169.253/32"

  tags = { Name = "${var.project_name}-egress-dns-udp" }
}

resource "aws_vpc_security_group_egress_rule" "dns_tcp" {
  security_group_id = aws_security_group.aggregator_egress.id
  description       = "DNS TCP to AWS resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = "169.254.169.253/32"

  tags = { Name = "${var.project_name}-egress-dns-tcp" }
}

# ---------------------------------------------------------------------------
# API egress security group — narrower; only needs Stellar RPC + internal
# ---------------------------------------------------------------------------
resource "aws_security_group" "api_egress" {
  name        = "${var.project_name}-${var.environment}-api-egress"
  description = "API outbound HTTPS restricted to Stellar RPC and internal services"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name        = "${var.project_name}-${var.environment}-api-egress"
    Environment = var.environment
    Purpose     = "api-egress-allowlist"
  })
}

resource "aws_vpc_security_group_egress_rule" "api_stellar_https" {
  security_group_id = aws_security_group.api_egress.id
  description       = "HTTPS egress to Stellar SDF (Soroban RPC + Horizon)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = local.oracle_egress_cidrs["stellar-aws"]

  tags = { Name = "${var.project_name}-api-egress-stellar" }
}

resource "aws_vpc_security_group_egress_rule" "api_internal_postgres" {
  security_group_id = aws_security_group.api_egress.id
  description       = "Internal egress: PostgreSQL"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = data.aws_vpc.selected.cidr_block

  tags = { Name = "${var.project_name}-api-egress-postgres" }
}

resource "aws_vpc_security_group_egress_rule" "api_internal_redis" {
  security_group_id = aws_security_group.api_egress.id
  description       = "Internal egress: Redis"
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6380
  cidr_ipv4         = data.aws_vpc.selected.cidr_block

  tags = { Name = "${var.project_name}-api-egress-redis" }
}

resource "aws_vpc_security_group_egress_rule" "api_dns_udp" {
  security_group_id = aws_security_group.api_egress.id
  description       = "DNS UDP to AWS resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = "169.254.169.253/32"

  tags = { Name = "${var.project_name}-api-egress-dns-udp" }
}

resource "aws_vpc_security_group_egress_rule" "api_dns_tcp" {
  security_group_id = aws_security_group.api_egress.id
  description       = "DNS TCP to AWS resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = "169.254.169.253/32"

  tags = { Name = "${var.project_name}-api-egress-dns-tcp" }
}

data "aws_vpc" "selected" {
  id = var.vpc_id
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------
output "aggregator_egress_sg_id" {
  description = "Security group ID for the aggregator egress allowlist"
  value       = aws_security_group.aggregator_egress.id
}

output "api_egress_sg_id" {
  description = "Security group ID for the API egress allowlist"
  value       = aws_security_group.api_egress.id
}
