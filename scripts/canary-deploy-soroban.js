#!/usr/bin/env node
/**
 * Canary contract deployment script.
 *
 * Deploys a new Soroban Price Oracle contract alongside the currently running
 * stable contract.  The canary contract receives a configurable percentage of
 * price submissions controlled by the aggregator's TrafficSplitter.
 *
 * Usage:
 *   node scripts/canary-deploy-soroban.js [--mainnet] [--promote] [--rollback]
 *
 *   (no flag)    Deploy a new canary contract and print env var instructions.
 *   --promote    Swap canary → stable: write CANARY_CONTRACT_ID to CONTRACT_ID.
 *   --rollback   Disable the canary by clearing CANARY_CONTRACT_ID and
 *                CANARY_ENABLED from the local .env.canary state file.
 *   --mainnet    Target mainnet instead of testnet.
 *   --weight N   Set initial CANARY_TRAFFIC_WEIGHT (default 10).
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Keypair, SorobanRpc, TransactionBuilder, Operation, xdr } from '@stellar/stellar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NETWORK = process.argv.includes('--mainnet') ? 'mainnet' : 'testnet';
const PROMOTE = process.argv.includes('--promote');
const ROLLBACK = process.argv.includes('--rollback');
const weightArg = process.argv.indexOf('--weight');
const INITIAL_WEIGHT = weightArg !== -1 ? parseInt(process.argv[weightArg + 1] || '10', 10) : 10;

const RPC_URL =
  NETWORK === 'mainnet'
    ? process.env.SOROBAN_RPC_URL || 'https://soroban-rpc.mainnet.stellar.gateway.money'
    : process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const PASSPHRASE =
  NETWORK === 'mainnet'
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';
const SECRET = process.env.ADMIN_SECRET_KEY;
const CANARY_STATE_FILE = path.resolve(__dirname, '../.canary-state.json');

function readCanaryState() {
  if (!fs.existsSync(CANARY_STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(CANARY_STATE_FILE, 'utf-8'));
}

function writeCanaryState(state) {
  fs.writeFileSync(CANARY_STATE_FILE, JSON.stringify(state, null, 2));
}

async function waitForTx(server, hash) {
  let status;
  do {
    await new Promise((r) => setTimeout(r, 1500));
    status = await server.getTransaction(hash);
  } while (status.status === 'NOT_FOUND');
  return status;
}

function parseContractIdFromResult(status) {
  // Extract contract ID from the transaction result XDR when available.
  // Falls back to a placeholder when the SDK doesn't expose it directly.
  try {
    if (status.resultMetaXdr) {
      const meta = xdr.TransactionMeta.fromXDR(status.resultMetaXdr, 'base64');
      const ops = meta.v3?.sorobanMeta?.()?.returnValue?.();
      if (ops) return ops.toString();
    }
  } catch {
    // XDR parsing is best-effort; the operator reads it from the logs.
  }
  return null;
}

async function deploy() {
  if (!SECRET) {
    console.error('ERROR: ADMIN_SECRET_KEY not set in .env');
    process.exit(1);
  }

  console.log(`\n[Canary Deploy] Network: ${NETWORK}`);
  console.log(`[Canary Deploy] RPC:     ${RPC_URL}`);
  console.log(`[Canary Deploy] Weight:  ${INITIAL_WEIGHT}%\n`);

  const keypair = Keypair.fromSecret(SECRET);
  const server = new SorobanRpc.Server(RPC_URL);

  console.log('Building contract WASM...');
  execSync('cargo build --release', {
    cwd: path.resolve(__dirname, '../contracts/price-oracle'),
    stdio: 'inherit',
  });

  const wasmPath = path.resolve(
    __dirname,
    '../contracts/price-oracle/target/release/price_oracle.wasm',
  );
  const wasm = fs.readFileSync(wasmPath);
  console.log(`WASM size: ${(wasm.length / 1024).toFixed(2)} KB`);

  const account = await server.getAccount(keypair.publicKey());

  // 1. Upload WASM
  console.log('\nUploading contract WASM...');
  const uploadTx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(30)
    .build();
  uploadTx.sign(keypair);

  const uploadResp = await server.sendTransaction(uploadTx);
  console.log(`Upload TX hash: ${uploadResp.hash}`);
  if (uploadResp.status === 'PENDING') {
    const uploadStatus = await waitForTx(server, uploadResp.hash);
    if (uploadStatus.status !== 'SUCCESS') {
      console.error('WASM upload failed:', uploadStatus.status);
      process.exit(1);
    }
    console.log('WASM upload confirmed.');
  }

  // 2. Create canary contract instance
  console.log('\nCreating canary contract instance...');
  const createAccount = await server.getAccount(keypair.publicKey());
  const createTx = new TransactionBuilder(createAccount, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.createContract({ wasm, address: keypair.publicKey() }))
    .setTimeout(30)
    .build();
  createTx.sign(keypair);

  const createResp = await server.sendTransaction(createTx);
  console.log(`Create TX hash: ${createResp.hash}`);

  let canaryContractId = null;
  if (createResp.status === 'PENDING') {
    const createStatus = await waitForTx(server, createResp.hash);
    if (createStatus.status !== 'SUCCESS') {
      console.error('Contract creation failed:', createStatus.status);
      process.exit(1);
    }
    canaryContractId = parseContractIdFromResult(createStatus);
    console.log('\nCanary contract deployed successfully!');
    console.log(`Create TX: ${createResp.hash}`);
    if (canaryContractId) {
      console.log(`Contract ID: ${canaryContractId}`);
    } else {
      console.log(
        'Contract ID: parse from create TX result XDR (see transaction in Stellar Explorer)',
      );
      canaryContractId = `<parse-from-tx-${createResp.hash.slice(0, 8)}>`;
    }
  }

  const state = readCanaryState();
  state.canaryContractId = canaryContractId;
  state.stableContractId = process.env.CONTRACT_ID || state.stableContractId || '';
  state.deployedAt = new Date().toISOString();
  state.network = NETWORK;
  state.trafficWeight = INITIAL_WEIGHT;
  writeCanaryState(state);

  console.log('\n──────────────────────────────────────────');
  console.log('Add these to your .env to activate the canary:');
  console.log(`  CANARY_CONTRACT_ID=${canaryContractId}`);
  console.log(`  CANARY_ENABLED=true`);
  console.log(`  CANARY_TRAFFIC_WEIGHT=${INITIAL_WEIGHT}`);
  console.log(`  CANARY_MAX_DEVIATION_BPS=500`);
  console.log(`  CANARY_MAX_CONSECUTIVE_FAILURES=3`);
  console.log('──────────────────────────────────────────');
  console.log('\nMonitor canary health:');
  console.log('  curl http://localhost:4002/health?verbose=true | jq .canaryMetrics');
  console.log('\nTo promote canary to stable:');
  console.log('  node scripts/canary-deploy-soroban.js --promote');
  console.log('\nTo rollback:');
  console.log('  node scripts/canary-deploy-soroban.js --rollback\n');
}

async function promote() {
  const state = readCanaryState();
  if (!state.canaryContractId) {
    console.error('No canary contract found in .canary-state.json. Deploy first.');
    process.exit(1);
  }
  console.log(`\n[Canary Promote] ${state.canaryContractId} → stable`);
  console.log('Update your .env:');
  console.log(`  CONTRACT_ID=${state.canaryContractId}`);
  console.log('  CANARY_ENABLED=false');
  console.log('  CANARY_CONTRACT_ID=   (clear this)');
  console.log('\nThen restart the aggregator service.\n');

  state.promotedAt = new Date().toISOString();
  state.previousStableContractId = state.stableContractId;
  state.stableContractId = state.canaryContractId;
  state.canaryContractId = null;
  writeCanaryState(state);
}

function rollback() {
  const state = readCanaryState();
  console.log('\n[Canary Rollback] Disabling canary deployment');
  console.log('Update your .env:');
  console.log('  CANARY_ENABLED=false');
  console.log('  CANARY_CONTRACT_ID=   (clear this)');
  if (state.stableContractId) {
    console.log(`  CONTRACT_ID=${state.stableContractId}  (already set — no change needed)`);
  }
  console.log('\nThen restart the aggregator service.\n');

  state.rolledBackAt = new Date().toISOString();
  state.canaryContractId = null;
  writeCanaryState(state);
}

if (PROMOTE) {
  promote().catch(console.error);
} else if (ROLLBACK) {
  rollback();
} else {
  deploy().catch(console.error);
}
