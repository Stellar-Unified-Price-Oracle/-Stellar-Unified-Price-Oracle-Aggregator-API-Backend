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

# ── IAM Role for MirrorMaker EC2 Instance ──────────────────────────────────────

resource "aws_iam_role" "mirror_maker_instance_role" {
  name = "${var.project_name}-mirror-maker-instance-role-${var.region_code}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Principal" = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_instance_profile" "mirror_maker" {
  name = "${var.project_name}-mirror-maker-instance-profile-${var.region_code}"
  role = aws_iam_role.mirror_maker_instance_role.name
}

# Policy for EC2 instance to access SSM, CloudWatch, and Secrets Manager
resource "aws_iam_policy" "mirror_maker_instance_policy" {
  name        = "${var.project_name}-mirror-maker-instance-policy-${var.region_code}"
  description = "Policy for MirrorMaker EC2 instance"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:*:parameter/${var.project_name}/mirror-maker/*"
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.project_name}/mirror-maker/*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/mirror-maker/*"
      },
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData",
          "ec2:DescribeInstances"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:UpdateInstanceInformation"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = "ssmmessages:*"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = "ec2messages:*"
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_policy_attachment" "mirror_maker_instance_policy" {
  name       = "${var.project_name}-mirror-maker-instance-policy-attach-${var.region_code}"
  roles      = [aws_iam_role.mirror_maker_instance_role.name]
  policy_arn = aws_iam_policy.mirror_maker_instance_policy.arn
}

# ── Security Group for MirrorMaker EC2 ─────────────────────────────────────────

resource "aws_security_group" "mirror_maker_sg" {
  name        = "${var.project_name}-mirror-maker-${var.region_code}"
  description = "Security group for MirrorMaker EC2 instance"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.project_name}-mirror-maker-sg-${var.region_code}" })
}

# Allow inbound SSH from bastion (if provided)
resource "aws_security_group_rule" "mirror_maker_ssh" {
  count             = var.bastion_security_group_id != "" ? 1 : 0
  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  security_group_id = aws_security_group.mirror_maker_sg.id
  source_security_group_id = var.bastion_security_group_id
}

# ── CloudWatch Log Group ───────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "mirror_maker" {
  name              = "/aws/mirror-maker/${var.project_name}/${var.region_code}"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, { Name = "${var.project_name}-mirror-maker-logs-${var.region_code}" })
}

# ── Parameter Store for MirrorMaker Configuration ──────────────────────────────

resource "aws_ssm_parameter" "mm2_config" {
  name            = "${var.project_name}/mirror-maker/config/${var.region_code}"
  type            = "String"
  tier            = "Advanced"
  description     = "MirrorMaker 2 configuration for ${var.region_code}"
  value           = base64encode(local.mm2_config_content)
  overwrite       = true
  allowed_pattern = ".*"

  tags = merge(var.tags, { Name = "${var.project_name}-mirror-maker-config-${var.region_code}" })
}

# ── Startup Script for MirrorMaker ─────────────────────────────────────────────

resource "aws_ssm_parameter" "mirror_maker_startup_script" {
  name            = "${var.project_name}/mirror-maker/startup/${var.region_code}"
  type            = "String"
  description     = "Startup script for MirrorMaker EC2 instance"
  value           = base64encode(local.startup_script)
  overwrite       = true
  allowed_pattern = ".*"

  tags = merge(var.tags, { Name = "${var.project_name}-mirror-maker-startup-${var.region_code}" })
}

# ── EC2 Instance for MirrorMaker ───────────────────────────────────────────────

resource "aws_instance" "mirror_maker" {
  count                = var.enabled ? 1 : 0
  ami                  = data.aws_ami.amazon_linux_2.id
  instance_type        = var.instance_type
  iam_instance_profile = aws_iam_instance_profile.mirror_maker.name
  subnet_id            = var.subnet_id
  vpc_security_group_ids = [aws_security_group.mirror_maker_sg.id]

  user_data = base64encode(local.user_data_script)

  tag_specifications {
    resource_type = "instance"
    tags = merge(
      var.tags,
      {
        Name = "${var.project_name}-mirror-maker-${var.region_code}"
      }
    )
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

# ── Data Source for Amazon Linux 2 AMI ─────────────────────────────────────────

data "aws_ami" "amazon_linux_2" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*-x86_64-gp2"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

# ── Local Configuration Files ──────────────────────────────────────────────────

locals {
  mm2_config_content = templatefile("${path.module}/mm2.properties.tpl", {
    source_bootstrap_servers = var.source_bootstrap_servers
    target_bootstrap_servers = var.target_bootstrap_servers
    source_security_protocol = var.source_security_protocol
    target_security_protocol = var.target_security_protocol
    mm2_consumer_group       = var.mm2_consumer_group
    replication_topic_regex  = var.replication_topic_regex
    sync_offsets_interval    = var.sync_offsets_interval_seconds
  })

  startup_script = templatefile("${path.module}/start-mm2.sh.tpl", {
    kafka_version            = var.kafka_version
    mm2_config_param_name    = aws_ssm_parameter.mm2_config.name
    log_group_name           = aws_cloudwatch_log_group.mirror_maker.name
    region                   = var.aws_region
  })

  user_data_script = templatefile("${path.module}/user-data.sh.tpl", {
    aws_region               = var.aws_region
    startup_script_param     = aws_ssm_parameter.mirror_maker_startup_script.name
    log_group_name           = aws_cloudwatch_log_group.mirror_maker.name
  })
}

# ── CloudWatch Alarm for MirrorMaker Health ────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "mirror_maker_lag_alarm" {
  count               = var.enabled ? 1 : 0
  alarm_name          = "${var.project_name}-mirror-maker-lag-${var.region_code}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MirrorMakerLag"
  namespace           = "StellarOracle/Replication"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.lag_alarm_threshold_ms
  alarm_description   = "MirrorMaker lag exceeds ${var.lag_alarm_threshold_ms}ms"
  alarm_actions       = var.alarm_action_arns
  treat_missing_data  = "breaching"

  tags = merge(var.tags, { Name = "${var.project_name}-mirror-maker-lag-alarm-${var.region_code}" })
}
