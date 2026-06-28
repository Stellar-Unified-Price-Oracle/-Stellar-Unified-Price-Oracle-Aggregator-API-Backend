#!/usr/bin/env tsx
/**
 * Operator helper for encryption at rest (issue #41).
 *
 * Usage:
 *   tsx scripts/encrypt-secret.ts genkey                 Generate a new 32-byte key (hex)
 *   tsx scripts/encrypt-secret.ts encrypt "<plaintext>"  Encrypt a value with ENCRYPTION_KEY
 *   tsx scripts/encrypt-secret.ts decrypt "<payload>"    Decrypt an enc: payload
 *
 * The encrypted output (an `enc:v1:...` string) can be pasted directly into a
 * .env value (e.g. ADMIN_SECRET_KEY, CHAINLINK_API_KEY, DATABASE_URL); the
 * services decrypt it transparently at startup.
 *
 * Key rotation:
 *   1. Generate a new key, move the current ENCRYPTION_KEY to ENCRYPTION_KEY_PREVIOUS.
 *   2. Set the new key as ENCRYPTION_KEY.
 *   3. Re-encrypt secrets/data with the new key; values under the old key keep
 *      decrypting until you drop ENCRYPTION_KEY_PREVIOUS.
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

async function main(): Promise<void> {
  const { encrypt, decrypt, isEncryptionConfigured } = await import('../api/src/services/crypto');
  const command = process.argv[2];
  const value = process.argv[3];

  switch (command) {
    case 'genkey': {
      const key = crypto.randomBytes(32).toString('hex');
      console.log(key);
      console.log('\nAdd to your .env as:');
      console.log(`ENCRYPTION_KEY=${key}`);
      break;
    }
    case 'encrypt': {
      if (!value) throw new Error('Usage: encrypt "<plaintext>"');
      if (!isEncryptionConfigured()) throw new Error('ENCRYPTION_KEY is not set in the environment');
      console.log(encrypt(value));
      break;
    }
    case 'decrypt': {
      if (!value) throw new Error('Usage: decrypt "<payload>"');
      if (!isEncryptionConfigured()) throw new Error('ENCRYPTION_KEY is not set in the environment');
      console.log(decrypt(value));
      break;
    }
    default:
      console.error('Unknown command. Use: genkey | encrypt | decrypt');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
