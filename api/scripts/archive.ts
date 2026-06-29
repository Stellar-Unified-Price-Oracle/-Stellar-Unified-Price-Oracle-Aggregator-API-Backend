import dotenv from 'dotenv';
import path from 'path';
import { config } from '../src/config';
import { logger } from '../src/middleware/logger';
import { DatabaseClient, setDb } from '../src/services/database';
import { ArchivalService } from '../src/services/archival';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * CLI for the data archival lifecycle (issue #43).
 *
 *   tsx scripts/archive.ts run            # archive + apply retention
 *   tsx scripts/archive.ts run --dry-run  # preview without changing anything
 *   tsx scripts/archive.ts restore [file] # restore one/all archive files
 */
async function main(): Promise<void> {
  const command = process.argv[2] || 'run';
  const dryRun = process.argv.includes('--dry-run');

  if (!config.databaseUrl) {
    logger.error('DATABASE_URL is not configured');
    process.exit(1);
  }

  const db = new DatabaseClient(config.databaseUrl, logger);
  await db.initialize();
  setDb(db);

  const archival = new ArchivalService(db, logger);

  try {
    if (command === 'run') {
      const result = await archival.runOnce(dryRun);
      logger.info('Archival result', result);
    } else if (command === 'restore') {
      const file = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
      const restored = await archival.restore(file);
      logger.info(`Restored ${restored} record(s)`);
    } else {
      logger.error(`Unknown command: ${command}. Use "run" or "restore".`);
      process.exit(1);
    }
  } catch (err) {
    logger.error('Archival command failed', err);
    process.exitCode = 1;
  } finally {
    await db.disconnect();
  }
}

main();
