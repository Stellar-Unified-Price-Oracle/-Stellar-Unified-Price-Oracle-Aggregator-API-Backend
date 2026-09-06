# ── Backend ───────────────────────────────────────────────────────────────────
# Uncomment and populate to use remote state for this environment:
#
# terraform {
#   backend "s3" {
#     bucket         = "stellar-oracle-terraform-state"
#     key            = "eu-west-1/terraform.tfstate"
#     region         = "us-east-1"
#     dynamodb_table = "terraform-state-lock"
#     encrypt        = true
#   }
# }

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ── Provider ──────────────────────────────────────────────────────────────────

provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = var.tags
  }
}

# ── Networking ────────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project_name}-vpc" }
}

data "aws_availability_zones" "available" {}

resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = { Name = "${var.project_name}-private-${count.index + 1}" }
}

resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${var.project_name}-public-${count.index + 1}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project_name}-igw" }
}

resource "aws_eip" "nat" {
  count  = length(var.public_subnet_cidrs)
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  count         = length(var.public_subnet_cidrs)
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = { Name = "${var.project_name}-nat-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.project_name}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = length(aws_subnet.private)
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = { Name = "${var.project_name}-private-rt-${count.index + 1}" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ── ECS Cluster ───────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = "FARGATE"
  }
}

# ── Database Module ───────────────────────────────────────────────────────────

module "database" {
  source = "../../modules/database"

  project_name          = var.project_name
  environment           = var.environment
  vpc_id                = aws_vpc.main.id
  private_subnet_ids    = aws_subnet.private[*].id
  api_security_group_id = module.api.security_group_id
  db_name               = var.db_name
  db_username           = var.db_username
  db_password           = var.db_password
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
}

# ── API Module ────────────────────────────────────────────────────────────────

module "api" {
  source = "../../modules/api"

  project_name       = var.project_name
  environment        = var.environment
  cluster_id         = aws_ecs_cluster.main.id
  cluster_name       = aws_ecs_cluster.main.name
  private_subnet_ids = aws_subnet.private[*].id
  public_subnet_ids  = aws_subnet.public[*].id
  vpc_id             = aws_vpc.main.id
  api_image          = var.api_image
  cpu                = var.api_cpu
  memory             = var.api_memory
  desired_count      = var.api_desired_count
  min_capacity       = var.api_min_capacity
  max_capacity       = var.api_max_capacity
  certificate_arn    = var.certificate_arn
  db_host            = module.database.db_endpoint
  db_name            = var.db_name
  db_username        = var.db_username
  db_password        = var.db_password
}

# ── Aggregator Module ─────────────────────────────────────────────────────────

module "aggregator" {
  source = "../../modules/aggregator"

  project_name       = var.project_name
  environment        = var.environment
  cluster_id         = aws_ecs_cluster.main.id
  cluster_name       = aws_ecs_cluster.main.name
  vpc_id             = aws_vpc.main.id
  private_subnet_ids = aws_subnet.private[*].id
  aggregator_image   = var.aggregator_image
  cpu                = var.aggregator_cpu
  memory             = var.aggregator_memory
  desired_count      = var.aggregator_desired_count
  min_capacity       = var.aggregator_min_capacity
  max_capacity       = var.aggregator_max_capacity
  db_host            = module.database.db_endpoint
  db_name            = var.db_name
  db_username        = var.db_username
  db_password        = var.db_password
}
