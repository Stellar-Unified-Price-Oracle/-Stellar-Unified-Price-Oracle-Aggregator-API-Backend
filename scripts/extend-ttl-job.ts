/**
 * Scheduled rent job for the PriceOracleContract (Issue #376).
 *
 * Invokes `extend_storage_ttl` on the deployed contract so persistent
 * PriceHistory entries and the shared instance storage entry (Admin,
 * GovernanceConfig, GovernanceProposal, MultiSigConfig) never hit their TTL
 * floor between runs. See docs/RENT_BUDGET.md for the funding and alerting
 * model this job is expected to run under.
 *
 * Usage:
 *   tsx scripts/extend-ttl-job.ts             # testnet
 *   tsx scripts/extend-ttl-job.ts --mainnet
 *
 * Requires the same .env ADMIN_SECRET_KEY / CONTRACT_ID conventions as
 * scripts/deploy-soroban.js, and the `stellar` CLI on PATH.
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NETWORK = process.argv.includes('--mainnet') ? 'mainnet' : 'testnet';
const CONTRACT_ID = process.env.PRICE_ORACLE_CONTRACT_ID;
const SOURCE_ACCOUNT = process.env.RENT_FUNDING_SECRET_KEY || process.env.ADMIN_SECRET_KEY;

if (!CONTRACT_ID) {
  console.error('ERROR: PRICE_ORACLE_CONTRACT_ID not set in .env');
  process.exit(1);
}
if (!SOURCE_ACCOUNT) {
  console.error('ERROR: RENT_FUNDING_SECRET_KEY (or ADMIN_SECRET_KEY) not set in .env');
  process.exit(1);
}

function run() {
  const startedAt = new Date().toISOString();
  console.log(`[extend-ttl-job] ${startedAt} network=${NETWORK} contract=${CONTRACT_ID}`);

  try {
    const output = execSync(
      `stellar contract invoke --id ${CONTRACT_ID} --source-account ${SOURCE_ACCOUNT} ` +
        `--network ${NETWORK} -- extend_storage_ttl`,
      { encoding: 'utf-8' },
    );
    console.log(output.trim());
    console.log(`[extend-ttl-job] completed at ${new Date().toISOString()}`);
  } catch (err) {
    // Non-zero exit from the CLI means the transaction failed — surface it
    // so the scheduler's failure alerting (see docs/RENT_BUDGET.md) fires.
    console.error('[extend-ttl-job] FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

run();
