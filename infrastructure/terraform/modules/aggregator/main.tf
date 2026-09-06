variable "project_name"       { type = string }
variable "environment"        { type = string }
variable "cluster_id"         { type = string }
variable "cluster_name"       { type = string }
variable "vpc_id"             { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "aggregator_image"   { type = string }
variable "cpu"                { type = number; default = 256 }
variable "memory"             { type = number; default = 512 }
variable "desired_count"      { type = number; default = 2 }
variable "min_capacity"       { type = number; default = 1 }
variable "max_capacity"       { type = number; default = 6 }
variable "db_host"            { type = string }
variable "db_name"            { type = string }
variable "db_username"        { type = string; sensitive = true }
variable "db_password"        { type = string; sensitive = true }
variable "redis_url"          { type = string; default = "" }

# ── IAM ───────────────────────────────────────────────────────────────────────

resource "aws_iam_role" "aggregator_execution" {
  name = "${var.project_name}-aggregator-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "aggregator_execution" {
  role       = aws_iam_role.aggregator_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "aggregator_task" {
  name = "${var.project_name}-aggregator-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# ── CloudWatch Log Group ──────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "aggregator" {
  name              = "/ecs/${var.project_name}/aggregator"
  retention_in_days = 30
}

# ── Security Group ────────────────────────────────────────────────────────────

resource "aws_security_group" "aggregator" {
  name        = "${var.project_name}-aggregator-sg"
  description = "Aggregator service: internal ports 4000/4001/4002"
  vpc_id      = var.vpc_id

  ingress {
    description = "Aggregator REST health port"
    from_port   = 4000
    to_port     = 4000
    protocol    = "tcp"
    self        = true
  }

  ingress {
    description = "Aggregator WebSocket port"
    from_port   = 4001
    to_port     = 4001
    protocol    = "tcp"
    self        = true
  }

  ingress {
    description = "Aggregator metrics port"
    from_port   = 4002
    to_port     = 4002
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ── ECS Task Definition ───────────────────────────────────────────────────────

data "aws_region" "current" {}

resource "aws_ecs_task_definition" "aggregator" {
  family                   = "${var.project_name}-aggregator"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.aggregator_execution.arn
  task_role_arn            = aws_iam_role.aggregator_task.arn

  container_definitions = jsonencode([{
    name      = "aggregator"
    image     = var.aggregator_image
    essential = true

    portMappings = [
      { containerPort = 4000, protocol = "tcp" },
      { containerPort = 4001, protocol = "tcp" },
      { containerPort = 4002, protocol = "tcp" }
    ]

    environment = [
      { name = "NODE_ENV",             value = var.environment },
      { name = "DB_HOST",              value = var.db_host },
      { name = "DB_NAME",              value = var.db_name },
      { name = "DB_USER",              value = var.db_username },
      { name = "DB_PASSWORD",          value = var.db_password },
      { name = "REDIS_URL",            value = var.redis_url },
      { name = "POLLING_INTERVAL_MS",  value = "30000" },
      { name = "WATCHED_ASSETS",       value = "XLM,USDC,BTC,ETH,USDT" }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.aggregator.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "aggregator"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:4000/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])
}

# ── ECS Service ───────────────────────────────────────────────────────────────

resource "aws_ecs_service" "aggregator" {
  name            = "${var.project_name}-aggregator"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.aggregator.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.aggregator.id]
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ── Auto Scaling ──────────────────────────────────────────────────────────────

resource "aws_appautoscaling_target" "aggregator" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.aggregator.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "aggregator_cpu" {
  name               = "${var.project_name}-aggregator-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.aggregator.resource_id
  scalable_dimension = aws_appautoscaling_target.aggregator.scalable_dimension
  service_namespace  = aws_appautoscaling_target.aggregator.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "aggregator_memory" {
  name               = "${var.project_name}-aggregator-memory-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.aggregator.resource_id
  scalable_dimension = aws_appautoscaling_target.aggregator.scalable_dimension
  service_namespace  = aws_appautoscaling_target.aggregator.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = 80.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "service_name" {
  value = aws_ecs_service.aggregator.name
}

output "security_group_id" {
  value = aws_security_group.aggregator.id
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.aggregator.name
}
