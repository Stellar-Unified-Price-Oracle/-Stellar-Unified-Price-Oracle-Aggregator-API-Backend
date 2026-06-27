#!/usr/bin/env tsx

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

async function migrate(): Promise<void> {
  try {
    // Import database module
    const { initializeDatabase, getDb, isDbAvailable } = await import('../api/src/services/database');

    console.log('Initializing database connection...');
    await initializeDatabase();

    if (!isDbAvailable()) {
      console.error('Database not available. Please configure DATABASE_* environment variables.');
      process.exit(1);
    }

    console.log('Database connected. Starting migration...');

    const db = await getDb();
    const dataDir = path.resolve(__dirname, '../data');

    if (!fs.existsSync(dataDir)) {
      console.log('No data directory found. Migration complete.');
      return;
    }

    const files = fs.readdirSync(dataDir).filter((f) => f.startsWith('history-') && f.endsWith('.json'));
    console.log(`Found ${files.length} history files to migrate`);

    let totalRecords = 0;

    for (const file of files) {
      const filePath = path.join(dataDir, file);
      const asset = file.replace('history-', '').replace('.json', '').toUpperCase();

      console.log(`Migrating ${asset}...`);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const records = JSON.parse(content);

        if (!Array.isArray(records)) {
          console.warn(`Skipping ${asset}: not an array`);
          continue;
        }

        for (const record of records) {
          try {
            await db.query(
              `INSERT INTO price_history (asset, price, decimals, source, timestamp)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (asset, source, timestamp) DO NOTHING`,
              [
                asset,
                record.price,
                record.decimals || 18,
                record.source || 'unknown',
                record.timestamp
              ]
            );
            totalRecords++;
          } catch (error) {
            console.error(`Failed to insert record for ${asset}:`, error);
          }
        }

        // Update aggregator state with latest price
        const latest = records[records.length - 1];
        if (latest) {
          await db.query(
            `INSERT INTO aggregator_state (asset, latest_price, latest_timestamp, confidence, active_sources)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (asset) DO UPDATE SET
               latest_price = $2,
               latest_timestamp = $3,
               confidence = $4,
               last_update = CURRENT_TIMESTAMP`,
            [
              asset,
              latest.price,
              latest.timestamp,
              1.0,
              JSON.stringify([latest.source || 'unknown'])
            ]
          );
        }
      } catch (error) {
        console.error(`Failed to migrate ${file}:`, error);
      }
    }

    console.log(`Migration complete. Imported ${totalRecords} price records.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  migrate();
}
