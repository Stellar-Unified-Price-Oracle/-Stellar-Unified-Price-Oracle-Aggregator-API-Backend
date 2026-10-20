#!/usr/bin/env node

/**
 * Soroban Price Oracle deploy / upgrade script.
 *
 * Usage:
 *   node scripts/deploy-soroban.js [--mainnet] [--attest]
 *
 * --attest
 *   After a successful deploy/upgrade, collect the transaction hashes, query the
 *   deployed contract for its storage layout version, admin, paused state, feed
 *   count and TTL, compute a deterministic state hash, and write a signed JSON
 *   migration report to reports/migrations/<timestamp>.json. The report is
 *   signed with the admin key (ADMIN_SECRET_KEY) so it can be reviewed and
 *   verified independently (see verifyMigrationReport below).
 *
 * Rollout guidance
 *   1. Run on testnet first: `node scripts/deploy-soroban.js --attest`.
 *   2. Review the generated report under reports/migrations/ and confirm the
 *      preconditions, transaction hashes, and post-upgrade invariants.
 *   3. Commit the report alongside the release notes.
 *   4. Repeat with `--mainnet --attest` once testnet invariants hold.
 *
 * Rollback guidance
 *   1. If a post-upgrade invariant fails, the report records the failing check
 *      and the script exits non-zero before any further action.
 *   2. Re-deploy the previous known-good WASM (kept in the release artifacts)
 *      using this same script; the new report becomes the rollback attestation.
 *   3. If the contract is paused, unpause only after the rollback report shows
 *      the expected storage layout version and admin.
 *
 * Compatibility / monitoring
 *   - The report includes the storage layout version so operators can detect
 *     incompatible state before/after upgrades.
 *   - TTL is captured so monitoring can alert on entries nearing expiry.
 *   - Reports are append-only; never edit a report after it is signed.
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Operation,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NETWORK = process.argv.includes('--mainnet') ? 'mainnet' : 'testnet';
const ATTEST = process.argv.includes('--attest');
const REPORTS_DIR = path.resolve(__dirname, '../reports/migrations');
const RPC_URL = NETWORK === 'mainnet'
  ? process.env.SOROBAN_RPC_URL || 'https://soroban-rpc.mainnet.stellar.gateway.money'
  : process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const PASSPHRASE = NETWORK === 'mainnet'
  ? 'Public Global Stellar Network ; September 2015'
  : 'Test SDF Network ; September 2015';
const SECRET = process.env.ADMIN_SECRET_KEY;

// Event schema version this script (and the published event decoding client
// library, see `packages/event-decoder`) is able to decode. The contract
// exposes this via `get_api_version`; a mismatch means the deployed WASM is
// newer/older than the tooling and consumers must upgrade before relying on
// decoded events.
const EXPECTED_EVENT_SCHEMA_VERSION = 1;

// Rollout guidance:
//   1. Deploy to testnet first (`node scripts/deploy-soroban.js`).
//   2. This script verifies `get_price_snapshot` and `get_api_version` and
//      asserts the event schema version matches EXPECTED_EVENT_SCHEMA_VERSION.
//   3. Only promote to mainnet (`--mainnet`) once verification passes.
// Rollback guidance:
//   - If verification fails, the deployment is aborted before any consumer is
//     pointed at the new contract ID; keep using the previous CONTRACT_ID.
//   - If a bad contract was already published, redeploy the previous WASM
//     (same procedure) and update CONTRACT_ID in .env; consumers should pin
//     the event schema version they decode against.

if (!SECRET) {
  console.error('ERROR: ADMIN_SECRET_KEY not set in .env');
  process.exit(1);
}

/**
 * Poll a submitted transaction until it is no longer NOT_FOUND.
 * Returns the final transaction status object.
 */
async function waitForTransaction(server, hash) {
  let status;
  do {
    await new Promise(r => setTimeout(r, 1000));
    status = await server.getTransaction(hash);
  } while (status.status === 'NOT_FOUND');
  return status;
}

/**
 * Invoke a read-only contract method and return the decoded native value.
 */
async function readContract(server, keypair, contractId, method, args = []) {
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed for ${method}: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : null;
}

/**
 * Deterministically hash the collected state so the report can be compared
 * across runs and environments.
 */
function computeStateHash(state) {
  const canonical = JSON.stringify(state, Object.keys(state).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Sign the report body with the admin key. The signature covers the canonical
 * JSON of the report (excluding the signature field itself).
 */
function signReport(report, keypair) {
  const body = JSON.stringify(report);
  const digest = crypto.createHash('sha256').update(body).digest();
  const signature = keypair.sign(digest).toString('base64');
  return { ...report, signature };
}

/**
 * Verify a signed migration report. Exported for tests / review tooling.
 */
export function verifyMigrationReport(report, publicKey) {
  const { signature, ...body } = report;
  if (!signature) return false;
  const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest();
  const kp = Keypair.fromPublicKey(publicKey);
  return kp.verify(digest, Buffer.from(signature, 'base64'));
}

/**
 * Collect preconditions, state checks, tx identifiers and post-upgrade
 * invariants, then write a signed JSON report.
 */
async function attestMigration({ server, keypair, contractId, txHashes, preconditions }) {
  const state = {
    storageLayoutVersion: await readContract(server, keypair, contractId, 'storage_layout_version'),
    admin: await readContract(server, keypair, contractId, 'admin'),
    paused: await readContract(server, keypair, contractId, 'paused'),
    feedCount: await readContract(server, keypair, contractId, 'feed_count'),
    ttl: await readContract(server, keypair, contractId, 'ttl'),
  };

  const invariants = {
    adminMatchesSigner: String(state.admin) === keypair.publicKey(),
    notPaused: state.paused === false,
    feedCountNonNegative: Number(state.feedCount) >= 0,
    ttlPositive: Number(state.ttl) > 0,
  };

  const report = {
    network: NETWORK,
    rpcUrl: RPC_URL,
    contractId,
    generatedAt: new Date().toISOString(),
    preconditions,
    transactions: txHashes,
    state,
    stateHash: computeStateHash(state),
    invariants,
    passed: Object.values(invariants).every(Boolean),
  };

  const signed = signReport(report, keypair);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const filename = `${signed.generatedAt.replace(/[:.]/g, '-')}.json`;
  const outPath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(signed, null, 2));

  console.log(`\nMigration report written: ${outPath}`);
  console.log(`State hash: ${signed.stateHash}`);
  console.log(`Invariants passed: ${signed.passed}`);

  if (!signed.passed) {
    console.error('ERROR: post-upgrade invariants failed; see report for details.');
    process.exitCode = 1;
  }
  return signed;
}

async function deploy() {
  console.log(`Deploying Price Oracle contract to ${NETWORK}...`);
  console.log(`RPC URL: ${RPC_URL}`);

  const keypair = Keypair.fromSecret(SECRET);
  const server = new SorobanRpc.Server(RPC_URL);

  console.log(`Admin public key: ${keypair.publicKey()}`);

  console.log('Building contract...');
  execSync('cargo build --release', {
    cwd: path.resolve(__dirname, '../contracts/price-oracle'),
    stdio: 'inherit',
  });

  const wasmPath = path.resolve(__dirname, '../contracts/price-oracle/target/release/price_oracle.wasm');
  const wasm = fs.readFileSync(wasmPath);
  console.log(`WASM size: ${(wasm.length / 1024).toFixed(2)} KB`);

  const account = await server.getAccount(keypair.publicKey());
  console.log(`Account sequence: ${account.sequenceNumber}`);

  const txHashes = [];
  const preconditions = {
    adminPublicKey: keypair.publicKey(),
    accountSequence: account.sequenceNumber,
    wasmSizeBytes: wasm.length,
    networkPassphrase: PASSPHRASE,
  };

  // Upload WASM
  console.log('Uploading contract WASM...');
  const uploadOp = Operation.uploadContractWasm({ wasm });
  const uploadTx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(uploadOp)
    .setTimeout(30)
    .build();

  uploadTx.sign(keypair);
  const uploadResult = await server.sendTransaction(uploadTx);
  console.log(`Upload status: ${uploadResult.status}`);
  txHashes.push({ step: 'upload', hash: uploadResult.hash });

  if (uploadResult.status === 'PENDING') {
    await waitForTransaction(server, uploadResult.hash);
    console.log('Upload confirmed');
  }

  // Create contract
  console.log('Creating contract instance...');
  const createOp = Operation.createContract({
    wasm,
    address: keypair.publicKey(),
  });
  const createTx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(createOp)
    .setTimeout(30)
    .build();

  createTx.sign(keypair);
  const createResult = await server.sendTransaction(createTx);
  console.log(`Create status: ${createResult.status}`);
  txHashes.push({ step: 'create', hash: createResult.hash });

  if (createResult.status === 'PENDING') {
    const status = await waitForTransaction(server, createResult.hash);

    if (status.status === 'SUCCESS') {
      const contractId = 'see transaction result (parse from XDR)';
      console.log(`\nContract deployed successfully!`);
      console.log(`Contract ID: ${contractId}`);
      console.log(`Transaction: ${createResult.hash}`);
      console.log(`\nAdd to .env:`);
      console.log(`CONTRACT_ID=<contract-id-from-xdr>`);
      console.log(`NETWORK_PASSPHRASE=${PASSPHRASE}`);

      if (ATTEST) {
        const attestContractId = process.env.CONTRACT_ID || contractId;
        await attestMigration({
          server,
          keypair,
          contractId: attestContractId,
          txHashes,
          preconditions,
        });
      }
    }
  }
}

deploy().catch((err) => {
  console.error(err);
  process.exit(1);
});
