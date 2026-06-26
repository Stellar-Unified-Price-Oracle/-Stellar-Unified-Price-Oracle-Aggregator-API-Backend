import dotenv from 'dotenv';
import path from 'path';
import { Client } from 'pg';
import { logger } from '../src/middleware/logger';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://oracle:oracle@localhost:5432/stellar_oracle';

async function migrate() {
  const migrate = require('node-pg-migrate');
  const migrationsPath = path.join(__dirname, '../migrations');
  const command = process.argv[2] || 'up';

  const client = new Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    logger.info(`Running migrations (${command})...`);

    const migrations = await migrate.default({
      dbClient: client,
      dir: migrationsPath,
      direction: command === 'down' ? 'down' : 'up',
      log: (msg: string) => logger.info(msg),
    });

    if (migrations.length === 0) {
      logger.info('No migrations to run');
    } else {
      logger.info(`${command === 'up' ? 'Applied' : 'Reverted'} ${migrations.length} migrations`);
    }
  } catch (error) {
    logger.error('Migration failed', { error });
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
