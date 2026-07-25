output "api_url" {
  description = "Public URL of the API load balancer"
  value       = module.api.api_url
}

output "api_load_balancer_dns" {
  description = "DNS name of the application load balancer"
  value       = module.api.load_balancer_dns
}

output "db_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port)"
  value       = module.database.db_endpoint
  sensitive   = true
}

output "db_name" {
  description = "Database name"
  value       = var.db_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name for the API"
  value       = module.api.service_name
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = aws_subnet.private[*].id
}
