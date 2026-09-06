output "instance_id" {
  description = "EC2 instance ID for MirrorMaker"
  value       = try(aws_instance.mirror_maker[0].id, null)
}

output "instance_arn" {
  description = "EC2 instance ARN"
  value       = try(aws_instance.mirror_maker[0].arn, null)
}

output "private_ip" {
  description = "Private IP of the MirrorMaker instance"
  value       = try(aws_instance.mirror_maker[0].private_ip, null)
}

output "security_group_id" {
  description = "Security group ID for MirrorMaker instance"
  value       = aws_security_group.mirror_maker_sg.id
}

output "iam_role_arn" {
  description = "IAM role ARN for MirrorMaker instance"
  value       = aws_iam_role.mirror_maker_instance_role.arn
}

output "iam_instance_profile_name" {
  description = "IAM instance profile name"
  value       = aws_iam_instance_profile.mirror_maker.name
}

output "cloudwatch_log_group_name" {
  description = "CloudWatch log group for MirrorMaker logs"
  value       = aws_cloudwatch_log_group.mirror_maker.name
}

output "mm2_config_ssm_parameter_name" {
  description = "SSM parameter name for MirrorMaker configuration"
  value       = aws_ssm_parameter.mm2_config.name
}
