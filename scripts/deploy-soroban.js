#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Keypair, SorobanRpc, TransactionBuilder, Operation } from '@stellar/stellar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NETWORK = process.argv.includes('--mainnet') ? 'mainnet' : 'testnet';
const RPC_URL = NETWORK === 'mainnet'
  ? process.env.SOROBAN_RPC_URL || 'https://soroban-rpc.mainnet.stellar.gateway.money'
  : process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const PASSPHRASE = NETWORK === 'mainnet'
  ? 'Public Global Stellar Network ; September 2015'
  : 'Test SDF Network ; September 2015';
const SECRET = process.env.ADMIN_SECRET_KEY;

if (!SECRET) {
  console.error('ERROR: ADMIN_SECRET_KEY not set in .env');
  process.exit(1);
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

  if (uploadResult.status === 'PENDING') {
    let status;
    do {
      await new Promise(r => setTimeout(r, 1000));
      status = await server.getTransaction(uploadResult.hash);
    } while (status.status === 'NOT_FOUND');
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

  if (createResult.status === 'PENDING') {
    let status;
    do {
      await new Promise(r => setTimeout(r, 1000));
      status = await server.getTransaction(createResult.hash);
    } while (status.status === 'NOT_FOUND');

    if (status.status === 'SUCCESS') {
      const contractId = 'see transaction result (parse from XDR)';
      console.log(`\nContract deployed successfully!`);
      console.log(`Contract ID: ${contractId}`);
      console.log(`Transaction: ${createResult.hash}`);
      console.log(`\nAdd to .env:`);
      console.log(`CONTRACT_ID=<contract-id-from-xdr>`);
      console.log(`NETWORK_PASSPHRASE=${PASSPHRASE}`);
    }
  }
}

deploy().catch(console.error);
