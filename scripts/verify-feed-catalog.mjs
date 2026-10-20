#!/usr/bin/env node
/**
 * scripts/verify-feed-catalog.mjs — Issue #725
 *
 * Verifies and computes canonical on-chain commitments for the feed catalog.
 * Allows consumers and CI pipelines to assert that off-chain feed configurations
 * match the on-chain compact commitment hash.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Default canonical feed catalog structure for watched oracle assets.
 */
export const DEFAULT_CATALOG = {
  version: 1,
  network: 'stellar',
  updatedAt: '2026-10-01T00:00:00Z',
  sources: [
    { name: 'Chainlink', type: 'off-chain', weightBps: 2500, active: true },
    { name: 'Band Protocol', type: 'off-chain', weightBps: 2500, active: true },
    { name: 'Redstone', type: 'off-chain', weightBps: 2500, active: true },
    { name: 'Reflector', type: 'off-chain', weightBps: 2500, active: true },
  ],
  feeds: [
    { asset: 'XLM', base: 'USD', decimals: 7, maxStalenessSeconds: 120, heartbeatSeconds: 30 },
    { asset: 'USDC', base: 'USD', decimals: 7, maxStalenessSeconds: 120, heartbeatSeconds: 30 },
    { asset: 'BTC', base: 'USD', decimals: 7, maxStalenessSeconds: 120, heartbeatSeconds: 30 },
    { asset: 'ETH', base: 'USD', decimals: 7, maxStalenessSeconds: 120, heartbeatSeconds: 30 },
    { asset: 'USDT', base: 'USD', decimals: 7, maxStalenessSeconds: 120, heartbeatSeconds: 30 },
  ],
};

/**
 * Deterministically serialize catalog object to canonical JSON string.
 */
export function canonicalizeCatalog(catalog) {
  function sortKeys(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    return Object.keys(obj)
      .sort()
      .reduce((res, key) => {
        res[key] = sortKeys(obj[key]);
        return res;
      }, {});
  }
  return JSON.stringify(sortKeys(catalog));
}

/**
 * Compute 32-byte SHA-256 digest of the canonical catalog JSON.
 */
export function computeCatalogHash(catalog) {
  const canonical = canonicalizeCatalog(catalog);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verify whether an off-chain catalog matches an expected 32-byte hex hash.
 */
export function verifyCatalogHash(catalog, expectedHashHex) {
  const actualHash = computeCatalogHash(catalog);
  return {
    valid: actualHash.toLowerCase() === expectedHashHex.toLowerCase(),
    actualHash,
    expectedHash: expectedHashHex,
  };
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const hash = computeCatalogHash(DEFAULT_CATALOG);
  console.log(`Feed Catalog Version: ${DEFAULT_CATALOG.version}`);
  console.log(`Canonical SHA-256 Hash: 0x${hash}`);

  if (process.argv.includes('--verify')) {
    const targetIdx = process.argv.indexOf('--verify') + 1;
    const expected = process.argv[targetIdx];
    if (!expected) {
      console.error('Error: specify hash to verify after --verify');
      process.exit(1);
    }
    const res = verifyCatalogHash(DEFAULT_CATALOG, expected.replace(/^0x/, ''));
    if (res.valid) {
      console.log('Verification PASSED: Off-chain catalog matches expected on-chain commitment.');
      process.exit(0);
    } else {
      console.error(`Verification FAILED! Actual: ${res.actualHash}, Expected: ${res.expectedHash}`);
      process.exit(1);
    }
  }
}
