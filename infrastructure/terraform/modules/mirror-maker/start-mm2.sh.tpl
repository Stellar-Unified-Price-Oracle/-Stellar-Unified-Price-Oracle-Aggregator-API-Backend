#!/bin/bash
set -e

# MirrorMaker 2 Startup Script
# Downloads Kafka, retrieves configuration from Parameter Store, and starts MM2

KAFKA_VERSION="${kafka_version}"
SCALA_VERSION="2.13"
MM2_CONFIG_PARAM="${mm2_config_param_name}"
LOG_GROUP="${log_group_name}"
AWS_REGION="${region}"
HOME_DIR="/opt/kafka"
MM2_LOG_DIR="$HOME_DIR/logs"
MM2_PID_FILE="$HOME_DIR/.mm2.pid"

# Create directories
mkdir -p $HOME_DIR
mkdir -p $MM2_LOG_DIR

# Download Kafka
echo "Downloading Kafka $KAFKA_VERSION..."
cd /tmp
if [ ! -f "kafka_$SCALA_VERSION-$KAFKA_VERSION.tgz" ]; then
  wget -q "https://archive.apache.org/dist/kafka/$KAFKA_VERSION/kafka_$SCALA_VERSION-$KAFKA_VERSION.tgz"
fi

# Extract to home directory
cd $HOME_DIR
tar xzf /tmp/kafka_$SCALA_VERSION-$KAFKA_VERSION.tgz
ln -sf kafka_$SCALA_VERSION-$KAFKA_VERSION kafka-home

# Retrieve MM2 configuration from Parameter Store
echo "Retrieving MirrorMaker configuration from Parameter Store..."
MM2_CONFIG_B64=$(aws ssm get-parameter \
  --name "$MM2_CONFIG_PARAM" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --region $AWS_REGION)

echo $MM2_CONFIG_B64 | base64 -d > $HOME_DIR/mm2.properties

# Configure JVM memory
export KAFKA_HEAP_OPTS="-Xmx1G -Xms256M"

# Start MirrorMaker 2 with output to log file and CloudWatch
echo "Starting MirrorMaker 2..."
nohup $HOME_DIR/kafka-home/bin/connect-mirror-maker.sh $HOME_DIR/mm2.properties \
  >> $MM2_LOG_DIR/mm2.log 2>&1 &

echo $! > $MM2_PID_FILE

# Monitor process and send logs to CloudWatch every 30 seconds
while true; do
  sleep 30
  
  if ! kill -0 $(cat $MM2_PID_FILE) 2>/dev/null; then
    echo "MirrorMaker process died. Restarting..."
    nohup $HOME_DIR/kafka-home/bin/connect-mirror-maker.sh $HOME_DIR/mm2.properties \
      >> $MM2_LOG_DIR/mm2.log 2>&1 &
    echo $! > $MM2_PID_FILE
  fi
  
  # Push logs to CloudWatch
  if [ -f $MM2_LOG_DIR/mm2.log ]; then
    aws logs put-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name "$(hostname -f)" \
      --log-events "$(tail -n 10 $MM2_LOG_DIR/mm2.log | jq -Rs .)" \
      --region $AWS_REGION 2>/dev/null || true
  fi
done
