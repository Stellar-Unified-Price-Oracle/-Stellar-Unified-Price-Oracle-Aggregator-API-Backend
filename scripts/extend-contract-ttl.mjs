#!/usr/bin/env node
// Issue #376 — periodic TTL/rent extension for the price-oracle contracts.
//
// Soroban persistent entries (PriceHistory) and each contract's instance
// storage (Admin, GovConfig, GovernanceProposal, PendingProxyUpgrade, etc.)
// have a TTL; once it expires the entry is archived and reads/writes fail
// until it's restored. This script calls the extend_instance_ttl and
// extend_price_history_ttl entry points (added in this change) on a
// schedule so the floor is never hit on mainnet.
//
// Usage:
//   ORACLE_CONTRACT_ID=C... \
//   GOVERNANCE_CONTRACT_ID=C... \
//   TRACKED_ASSETS=XLM,BTC,ETH,USDC,USDT \
//   node scripts/extend-contract-ttl.mjs [--network mainnet|testnet]
//
// Requires the `stellar` CLI (https://developers.stellar.org/docs/tools/cli)
// on PATH and STELLAR_ACCOUNT / a configured signer for the invoking key —
// extend_instance_ttl / extend_price_history_ttl are permissionless
// (no require_auth), so any funded account can call them; the caller only
// pays the resource fee for the extension.

import { execFileSync } from 'child_process';

const NETWORK = process.argv.includes('--mainnet') || process.argv.includes('--network=mainnet')
  ? 'mainnet'
  : process.env.STELLAR_NETWORK || 'testnet';

const ORACLE_CONTRACT_ID = process.env.ORACLE_CONTRACT_ID;
const GOVERNANCE_CONTRACT_ID = process.env.GOVERNANCE_CONTRACT_ID;
const PROXY_CONTRACT_ID = process.env.PROXY_CONTRACT_ID;
const TRACKED_ASSETS = (process.env.TRACKED_ASSETS || 'XLM,BTC,ETH,USDC,USDT')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SOURCE_ACCOUNT = process.env.STELLAR_ACCOUNT;

// Extend whenever remaining TTL drops below this many ledgers (~48h at 5s/ledger),
// out to roughly 30 days. Tune per the rent budget in docs/RENT_AND_TTL.md.
const THRESHOLD_LEDGERS = process.env.TTL_THRESHOLD_LEDGERS || '34560';
const EXTEND_TO_LEDGERS = process.env.TTL_EXTEND_TO_LEDGERS || '518400';

if (!ORACLE_CONTRACT_ID || !SOURCE_ACCOUNT) {
  console.error('ERROR: ORACLE_CONTRACT_ID and STELLAR_ACCOUNT must be set.');
  process.exit(1);
}

function invoke(contractId, fn, args) {
  const cmd = [
    'contract', 'invoke',
    '--id', contractId,
    '--source-account', SOURCE_ACCOUNT,
    '--network', NETWORK,
    '--',
    fn,
    ...args,
  ];
  console.log(`$ stellar ${cmd.join(' ')}`);
  execFileSync('stellar', cmd, { stdio: 'inherit' });
}

function extendInstance(contractId, label) {
  if (!contractId) return;
  console.log(`Extending instance TTL for ${label} (${contractId})...`);
  invoke(contractId, 'extend_instance_ttl', [
    '--threshold', THRESHOLD_LEDGERS,
    '--extend_to', EXTEND_TO_LEDGERS,
  ]);
}

extendInstance(ORACLE_CONTRACT_ID, 'PriceOracleContract');
extendInstance(GOVERNANCE_CONTRACT_ID, 'GovernanceContract');
extendInstance(PROXY_CONTRACT_ID, 'ProxyContract');

for (const asset of TRACKED_ASSETS) {
  console.log(`Extending PriceHistory TTL for ${asset}...`);
  invoke(ORACLE_CONTRACT_ID, 'extend_price_history_ttl', [
    '--asset', asset,
    '--threshold', THRESHOLD_LEDGERS,
    '--extend_to', EXTEND_TO_LEDGERS,
  ]);
  if (PROXY_CONTRACT_ID) {
    invoke(PROXY_CONTRACT_ID, 'extend_price_history_ttl', [
      '--asset', asset,
      '--threshold', THRESHOLD_LEDGERS,
      '--extend_to', EXTEND_TO_LEDGERS,
    ]);
  }
}

console.log('TTL extension pass complete.');
