import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { StartedTestContainer } from 'testcontainers';
import { logger } from '../../src/middleware/logger';

export interface TestContainers {
  postgres: StartedTestContainer;
  redis: StartedTestContainer;
  postgresUrl: string;
  redisUrl: string;
}

let containers: TestContainers | null = null;

export async function startTestContainers(): Promise<TestContainers> {
  if (containers) {
    return containers;
  }

  logger.info('Starting test containers...');

  const postgres = await new PostgreSqlContainer()
    .withDatabase('stellar_oracle_test')
    .withUsername('oracle')
    .withPassword('oracle')
    .start();

  const redis = await new RedisContainer().start();

  const postgresUrl = postgres.getConnectionUri();
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  containers = {
    postgres,
    redis,
    postgresUrl,
    redisUrl,
  };

  logger.info('Test containers started', {
    postgres: postgresUrl,
    redis: redisUrl,
  });

  return containers;
}

export async function stopTestContainers(): Promise<void> {
  if (!containers) {
    return;
  }

  logger.info('Stopping test containers...');

  await Promise.all([containers.postgres.stop(), containers.redis.stop()]);

  containers = null;
  logger.info('Test containers stopped');
}

export function getTestContainers(): TestContainers {
  if (!containers) {
    throw new Error('Test containers not started. Call startTestContainers() first.');
  }
  return containers;
}
