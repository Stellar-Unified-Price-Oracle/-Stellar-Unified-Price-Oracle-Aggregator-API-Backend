aws_region   = "eu-west-1"
environment  = "prod"
project_name = "stellar-oracle"

vpc_cidr             = "10.2.0.0/16"
private_subnet_cidrs = ["10.2.1.0/24", "10.2.2.0/24", "10.2.3.0/24"]
public_subnet_cidrs  = ["10.2.101.0/24", "10.2.102.0/24", "10.2.103.0/24"]

# API service sizing
api_cpu           = 512
api_memory        = 1024
api_desired_count = 2
api_min_capacity  = 2
api_max_capacity  = 10

# Aggregator service sizing
aggregator_cpu           = 256
aggregator_memory        = 512
aggregator_desired_count = 2
aggregator_min_capacity  = 1
aggregator_max_capacity  = 6

# Database
db_instance_class        = "db.r6g.medium"
db_allocated_storage     = 100
db_max_allocated_storage = 500
db_name                  = "oracle_db"
db_username              = "oracle_admin"
# db_password — set via TF_VAR_db_password or -var flag; never commit here

tags = {
  Project     = "stellar-oracle"
  ManagedBy   = "terraform"
  Region      = "eu-west-1"
  Environment = "prod"
}
