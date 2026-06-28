import dotenv from 'dotenv';
import path from 'path';
import { readdirSync } from 'fs';
import { Client } from 'pg';
import { logger } from '../src/middleware/logger';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://oracle:oracle@localhost:5432/stellar_oracle';
const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

interface Flags {
  command: 'up' | 'down';
  dryRun: boolean;
  count?: number;
}

function parseArgs(): Flags {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const command = (positional[0] as 'up' | 'down') === 'down' ? 'down' : 'up';
  const dryRun = args.includes('--dry-run');
  const countArg = args.find((a) => a.startsWith('--count='));
  const count = countArg ? parseInt(countArg.split('=')[1], 10) : undefined;
  return { command, dryRun, count };
}

/**
 * Validate that every migration file is reversible (exports both `up` and
 * `down`) before we touch the database. A migration without a rollback script
 * makes a failed deploy unrecoverable, so we refuse to run (issue #46).
 */
async function validateMigrations(): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();

  const problems: string[] = [];
  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(MIGRATIONS_DIR, file));
    if (typeof mod.up !== 'function') problems.push(`${file}: missing up() export`);
    if (typeof mod.down !== 'function') problems.push(`${file}: missing down() rollback export`);
  }

  if (problems.length > 0) {
    logger.error('Migration validation failed:');
    problems.forEach((p) => logger.error(`  - ${p}`));
    throw new Error(`${problems.length} migration(s) failed validation`);
  }
  logger.info(`Validated ${files.length} migration file(s): all reversible`);
}

async function migrate(): Promise<void> {
  const { command, dryRun, count } = parseArgs();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const runner = require('node-pg-migrate').default;

  await validateMigrations();

  const client = new Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    logger.info(
      `Running migrations (${command})${dryRun ? ' [dry-run]' : ''}` +
        `${count !== undefined ? ` count=${count}` : ''}...`,
    );

    const migrations = await runner({
      dbClient: client,
      dir: MIGRATIONS_DIR,
      direction: command,
      // Preview planned changes without committing (issue #46).
      dryRun,
      // Wrap the whole batch in one transaction so a failure auto-rolls back
      // everything instead of leaving the schema half-migrated (issue #46).
      singleTransaction: true,
      count: count ?? (command === 'down' ? 1 : Infinity),
      migrationsTable: 'pgmigrations',
      log: (msg: string) => logger.info(msg),
    });

    if (migrations.length === 0) {
      logger.info('No migrations to run');
    } else if (dryRun) {
      logger.info(
        `Dry-run: ${migrations.length} migration(s) would be ${command === 'up' ? 'applied' : 'reverted'}:`,
      );
      migrations.forEach((m: { name: string }) => logger.info(`  - ${m.name}`));
    } else {
      logger.info(`${command === 'up' ? 'Applied' : 'Reverted'} ${migrations.length} migration(s)`);
    }
  } catch (error) {
    // singleTransaction guarantees the DB was rolled back to its prior state.
    logger.error('Migration failed — changes rolled back', { error });
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
