#!/usr/bin/env node

// deploy-canary.js — canary deployments for Price Oracle contract upgrades.
//
// Issue #105: upgrade the oracle contract safely by first registering a
// *canary* implementation with the proxy (`set_canary`), letting the
// aggregator route a configurable share of live publish traffic to it
// (see services/aggregator/src/contract-publishing/canary.ts), observing
// outcomes, and only then promoting it (`promote_canary`) once it has proven
// itself.  Rollback is a zero-share `set_canary` call.
//
// Usage:
//   node scripts/deploy-canary.js deploy [share-bps] [--dry-run]
//   node scripts/deploy-canary.js promote            [--dry-run]
//   node scripts/deploy-canary.js rollback           [--dry-run]
//   node scripts/deploy-canary.js status
//
// Environment:
//   CONTRACT_ID       Proxy contract id the canary is registered against
//   ADMIN_SECRET_KEY  Admin keypair secret (signs set_canary/promote_canary)
//   SOROBAN_RPC_URL   RPC endpoint (defaults to testnet)
//   NETWORK_PASSPHRASE
//   --mainnet         Switch to the mainnet passphrase / RPC defaults
//
// See docs/CANARY_DEPLOYMENTS.md for the full runbook.

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
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NETWORK = process.argv.includes('--mainnet') ? 'mainnet' : 'testnet';
const RPC_URL =
  NETWORK === 'mainnet'
    ? process.env.SOROBAN_RPC_URL || 'https://soroban-rpc.mainnet.stellar.gateway.money'
    : process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const PASSPHRASE =
  NETWORK === 'mainnet'
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';
const SECRET = process.env.ADMIN_SECRET_KEY;
const PROXY_CONTRACT_ID = process.env.CONTRACT_ID;
const DRY_RUN = process.argv.includes('--dry-run');

if (!SECRET) {
  console.error('ERROR: ADMIN_SECRET_KEY not set in .env');
  process.exit(1);
}
if (!PROXY_CONTRACT_ID) {
  console.error('ERROR: CONTRACT_ID (the proxy contract) not set in .env');
  process.exit(1);
}

const server = new SorobanRpc.Server(RPC_URL);
const keypair = Keypair.fromSecret(SECRET);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send a transaction, poll until confirmed, return the result XDR (base64). */
async function sendAndConfirm(tx) {
  tx.sign(keypair);
  const hash = tx.hash().toString('hex');
  const send = await server.sendTransaction(tx);
  if (send.status !== 'PENDING' && send.status !== 'SUCCESS') {
    throw new Error(`transaction rejected: ${JSON.stringify(send)}`);
  }
  let result;
  do {
    await sleep(1000);
    result = await server.getTransaction(hash);
  } while (result.status === 'NOT_FOUND');
  if (result.status !== 'SUCCESS') {
    throw new Error(`transaction failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function buildAndSend(fnName, args, opts = {}) {
  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: opts.fee || '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: PROXY_CONTRACT_ID,
        function: fnName,
        args,
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(keypair);

  // Simulate first: catches auth/type errors and estimates the resource fee.
  const simulate = await server.simulateTransaction(tx);
  if (simulate.error) {
    throw new Error(`simulation failed for ${fnName}: ${JSON.stringify(simulate.error)}`);
  }
  const minFee = simulate.minResourceFee;
  if (minFee && Number(minFee) > 0 && !DRY_RUN) {
    const account2 = await server.getAccount(keypair.publicKey());
    const tx2 = new TransactionBuilder(account2, {
      fee: String(Math.max(100000, Number(minFee))),
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: PROXY_CONTRACT_ID,
          function: fnName,
          args,
        }),
      )
      .setTimeout(30)
      .build();
    tx2.sign(keypair);
    return sendAndConfirm(tx2);
  }
  if (DRY_RUN) {
    console.log(`[dry-run] would invoke ${fnName} with ${JSON.stringify(args)}`);
    return null;
  }
  return sendAndConfirm(tx);
}

/** Build the contract wasm and return { wasm, wasmPath }. */
function buildWasm() {
  console.log('Building contract (cargo build --release)...');
  execSync('cargo build --release', {
    cwd: path.resolve(__dirname, '../contracts/price-oracle'),
    stdio: 'inherit',
  });
  const wasmPath = path.resolve(__dirname, '../contracts/price-oracle/target/release/price_oracle.wasm');
  const wasm = fs.readFileSync(wasmPath);
  console.log(`WASM size: ${(wasm.length / 1024).toFixed(2)} KB`);
  return { wasm, wasmPath };
}

/** Parse the created contract id from a create-contract result XDR. */
function parseCreatedContractId(resultXdrBase64) {
  const txResult = xdr.TransactionResult.fromXDR(resultXdrBase64, 'base64');
  const createResult = txResult
    .result()
    .results()[0]
    .tr()
    .createContractResult();
  const contractId = createResult.contractAddress().contractId();
  return StrKey.encodeContract(contractId);
}

async function deploy(shareBps) {
  console.log(`Deploying canary implementation to ${NETWORK} (share: ${shareBps} bps)...`);
  const { wasm } = buildWasm();

  // 1. Upload the wasm and read back its hash.
  const uploadAccount = await server.getAccount(keypair.publicKey());
  const uploadTx = new TransactionBuilder(uploadAccount, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(30)
    .build();

  const uploadResult = DRY_RUN ? null : await sendAndConfirm(uploadTx);
  const wasmHash = uploadResult
    ? xdr.TransactionResult.fromXDR(uploadResult.resultXdr, 'base64')
        .result()
        .results()[0]
        .tr()
        .uploadContractWasmResult()
        .wasm()
        .hash()
    : null;
  console.log(`WASM hash: ${wasmHash ? wasmHash.toString('hex') : '(dry-run)'}`);

  // 2. Create the canary contract instance with a fresh salt.
  const salt = crypto.randomBytes(32);
  console.log(`Canary salt: ${salt.toString('hex')}`);
  if (DRY_RUN) {
    console.log('[dry-run] would create contract from wasm and register it as canary');
    return;
  }

  const createAccount = await server.getAccount(keypair.publicKey());
  const createTx = new TransactionBuilder(createAccount, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({ wasmHash, salt, address: keypair.publicKey() }),
    )
    .setTimeout(30)
    .build();

  const createResult = await sendAndConfirm(createTx);
  const canaryContractId = parseCreatedContractId(createResult.resultXdr);
  console.log(`Canary contract id: ${canaryContractId}`);

  // 3. Register the canary with the proxy (traffic share in basis points).
  await buildAndSend('set_canary', [
    nativeToScVal(keypair.publicKey(), { type: 'address' }),
    nativeToScVal(canaryContractId, { type: 'address' }),
    nativeToScVal(shareBps, { type: 'u32' }),
  ]);

  console.log(`\nCanary registered on proxy ${PROXY_CONTRACT_ID}`);
  console.log(`Traffic share: ${shareBps} bps (${(shareBps / 100).toFixed(1)}%)`);
  console.log('The aggregator will route the configured share of submissions to it.');
  console.log(`Observe metrics (canary_*) then run: node scripts/deploy-canary.js promote`);
}

async function promote() {
  console.log('Promoting canary to canonical implementation...');
  await buildAndSend('promote_canary', [nativeToScVal(keypair.publicKey(), { type: 'address' })]);
  console.log(`Canary promoted on proxy ${PROXY_CONTRACT_ID}.`);
  console.log('Implementation version was incremented; canary registration cleared.');
}

async function rollback() {
  console.log('Rolling back: zeroing canary traffic share...');
  const current = await status();
  if (!current || current.shareBps === 0) {
    console.log('No active canary registration — nothing to roll back.');
    return;
  }
  await buildAndSend('set_canary', [
    nativeToScVal(keypair.publicKey(), { type: 'address' }),
    nativeToScVal(current.contractId, { type: 'address' }),
    nativeToScVal(0, { type: 'u32' }),
  ]);
  console.log('Canary traffic share zeroed — aggregator now routes 100% to the canonical implementation.');
}

async function status() {
  try {
    const account = await server.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: PROXY_CONTRACT_ID,
          function: 'get_canary',
          args: [],
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(keypair);

    const simulate = await server.simulateTransaction(tx);
    if (simulate.error || !simulate.result?.retval) {
      console.log('Canary: none registered');
      return null;
    }
    const decoded = scValToNative(simulate.result.retval);
    if (Array.isArray(decoded) && decoded.length >= 2) {
      console.log(`Canary contract id: ${decoded[0]}`);
      console.log(`Traffic share: ${decoded[1]} bps (${(Number(decoded[1]) / 100).toFixed(1)}%)`);
      return { contractId: String(decoded[0]), shareBps: Number(decoded[1]) };
    }
    console.log('Canary: none registered');
    return null;
  } catch (err) {
    console.error(`Failed to read canary status: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function main() {
  const cmd = process.argv[2] || 'status';

  switch (cmd) {
    case 'deploy': {
      const rawShare = process.argv[3];
      let shareBps = 1000; // default 10%
      if (rawShare !== undefined) {
        shareBps = parseInt(rawShare, 10);
        if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10000) {
          console.error('ERROR: share-bps must be an integer in 0..10000');
          process.exit(1);
        }
      }
      await deploy(shareBps);
      break;
    }
    case 'promote':
      await promote();
      break;
    case 'rollback':
      await rollback();
      break;
    case 'status':
      await status();
      break;
    default:
      console.error(`Unknown command "${cmd}". Use: deploy [share-bps] | promote | rollback | status`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('ERROR:', err instanceof Error ? err.message : err);
  process.exit(1);
});
