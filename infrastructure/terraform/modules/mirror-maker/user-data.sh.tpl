#!/bin/bash
set -e

# EC2 User Data Script for MirrorMaker 2
# Installs dependencies and starts the MirrorMaker startup script

exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "[$(date)] User data script started"

# Update system
yum update -y

# Install required packages
yum install -y \
  java-11-amazon-corretto-headless \
  wget \
  curl \
  jq \
  aws-cli \
  aws-cfn-bootstrap

# Install CloudWatch Logs agent
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
rpm -U ./amazon-cloudwatch-agent.rpm

# Create CloudWatch agent configuration
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/opt/kafka/logs/mm2.log",
            "log_group_name": "${log_group_name}",
            "log_stream_name": "{instance_id}",
            "timezone": "UTC"
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "StellarOracle/MirrorMaker",
    "metrics_collected": {
      "cpu": {
        "measurement": ["cpu_usage_idle"],
        "metrics_collection_interval": 60,
        "totalcpu": false
      },
      "disk": {
        "measurement": ["used_percent"],
        "metrics_collection_interval": 60,
        "resources": ["/"]
      },
      "mem": {
        "measurement": ["mem_used_percent"],
        "metrics_collection_interval": 60
      }
    }
  }
}
EOF

# Substitute region
sed -i "s|\${log_group_name}|${log_group_name}|g" /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
sed -i "s|\${aws_region}|${aws_region}|g" /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Start CloudWatch agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Retrieve and execute MirrorMaker startup script from Parameter Store
STARTUP_SCRIPT_PARAM="${startup_script_param}"
STARTUP_SCRIPT_B64=$(aws ssm get-parameter \
  --name "$STARTUP_SCRIPT_PARAM" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --region ${aws_region})

echo $STARTUP_SCRIPT_B64 | base64 -d > /root/start-mm2.sh
chmod +x /root/start-mm2.sh

# Execute startup script as background process
nohup /root/start-mm2.sh > /var/log/mm2-startup.log 2>&1 &

echo "[$(date)] User data script completed"
