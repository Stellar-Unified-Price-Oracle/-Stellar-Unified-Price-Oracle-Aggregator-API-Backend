import { beforeAll, afterAll } from 'vitest';
import { startTestContainers, stopTestContainers, getTestContainers } from '../setup/test-containers';
import { initializeDatabase, runMigrations } from '../../src/services/database';
import { logger } from '../../src/middleware/logger';

let setupDone = false;

export async function setupE2E() {
  if (setupDone) {
    return getTestContainers();
  }

  const containers = await startTestContainers();

  await initializeDatabase({
    url: containers.postgresUrl,
    poolMin: 1,
    poolMax: 5,
  });

  try {
    await runMigrations(containers.postgresUrl);
  } catch (error) {
    logger.warn('Migrations may have already run or not be available in test environment');
  }

  setupDone = true;
  return containers;
}

export async function teardownE2E() {
  await stopTestContainers();
}

export function getE2EContainers() {
  return getTestContainers();
}
