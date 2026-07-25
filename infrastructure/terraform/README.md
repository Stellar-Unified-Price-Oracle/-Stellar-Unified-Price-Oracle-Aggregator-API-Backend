# Stellar Oracle — Terraform Infrastructure

This directory contains Terraform configuration for deploying the Stellar Unified Price Oracle API Backend on AWS using ECS Fargate and RDS PostgreSQL.

## Architecture

```
Internet
  │
  ▼
ALB (public subnets)
  │
  ▼
ECS Fargate — API Tasks (private subnets)
  │
  ▼
RDS PostgreSQL (private subnets)
```

## Modules

| Module | Description |
|--------|-------------|
| `modules/api` | ECS Fargate service, ALB, IAM roles, auto-scaling policies |
| `modules/database` | RDS PostgreSQL instance, subnet group, security group |

## Prerequisites

- Terraform >= 1.5.0
- AWS CLI configured with appropriate credentials
- An S3 bucket + DynamoDB table for remote state (recommended)
- An ACM certificate ARN if you want HTTPS

## Quick Start

```bash
# 1. Initialise (configure backend first)
terraform init \
  -backend-config="bucket=my-tf-state" \
  -backend-config="key=stellar-oracle/terraform.tfstate" \
  -backend-config="region=us-east-1"

# 2. Create a tfvars file
cat > prod.tfvars <<EOF
aws_region  = "us-east-1"
environment = "prod"
api_image   = "123456789.dkr.ecr.us-east-1.amazonaws.com/stellar-oracle-api:latest"
db_password = "CHANGE_ME_USE_SECRETS_MANAGER"
EOF

# 3. Plan
terraform plan -var-file=prod.tfvars

# 4. Apply
terraform apply -var-file=prod.tfvars
```

## Key Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `aws_region` | AWS region | `us-east-1` |
| `environment` | Environment name | `prod` |
| `api_image` | Docker image URI | _(required)_ |
| `api_min_capacity` | Min ECS tasks | `2` |
| `api_max_capacity` | Max ECS tasks | `10` |
| `db_instance_class` | RDS instance class | `db.t3.medium` |
| `db_password` | DB master password | _(required, sensitive)_ |

## Outputs

| Output | Description |
|--------|-------------|
| `api_url` | Public API URL (HTTP or HTTPS) |
| `api_load_balancer_dns` | ALB DNS name |
| `db_endpoint` | RDS endpoint (sensitive) |
| `ecs_cluster_name` | ECS cluster name |
| `ecs_service_name` | ECS service name |

## Auto Scaling

Two target-tracking policies are attached to the ECS service:
- **CPU**: scales out when average CPU > 70%, scales in after 5 min cooldown
- **Memory**: scales out when average memory > 80%, scales in after 5 min cooldown

Capacity bounds: min 2 / max 10 tasks (configurable via `api_min_capacity` / `api_max_capacity`).

## Destroying

```bash
terraform destroy -var-file=prod.tfvars
```

Production environments have `deletion_protection = true` on the RDS instance. Disable it first if you need a full teardown.
