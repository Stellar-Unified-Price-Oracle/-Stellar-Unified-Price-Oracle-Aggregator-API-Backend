#!/usr/bin/env node
/**
 * Feed catalog publication pipeline (issue #670).
 *
 * Usage:
 *   node scripts/feed-catalog-release.mjs --check
 *   node scripts/feed-catalog-release.mjs --publish --key <pem> --key-id <id> --channel production
 *   node scripts/feed-catalog-release.mjs --verify [--public-key <pem>] [--channel production]
 *   node scripts/feed-catalog-release.mjs --provenance
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadReleaseChain,
  publishRelease,
  validateCatalog,
  verifyReleaseChain,
} from './lib/feed-catalog-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOG = path.join(ROOT, 'config/feed-catalog.json');
const DEFAULT_RELEASES = path.join(ROOT, 'releases/feed-catalog');

function parseArgs(argv) {
  const args = { catalog: DEFAULT_CATALOG, releasesDir: DEFAULT_RELEASES };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    if (['check', 'publish', 'verify', 'provenance', 'help'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (key === 'catalog') args.catalog = path.resolve(value);
    else if (key === 'releases-dir') args.releasesDir = path.resolve(value);
    else if (key === 'key') args.key = value;
    else if (key === 'key-id') args.keyId = value;
    else if (key === 'channel') args.channel = value;
    else if (key === 'public-key') args.publicKey = value;
    else if (key === 'published-at') args.publishedAt = value;
    else throw new Error(`unknown argument --${key}`);
  }
  return args;
}

async function readPem(value, label) {
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return value;
  try {
    return await readFile(value, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label} at ${value}: ${error.message}`);
  }
}

function printErrors(errors) {
  for (const error of errors) {
    console.error(`${error.path}: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('See the header of scripts/feed-catalog-release.mjs for usage.');
    return 0;
  }

  if (args.check) {
    const catalog = JSON.parse(await readFile(args.catalog, 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length > 0) {
      printErrors(errors);
      return 1;
    }
    const chain = await loadReleaseChain(args.releasesDir);
    if (chain.length > 0) {
      const result = verifyReleaseChain(chain);
      if (!result.valid) {
        printErrors(result.errors);
        return 1;
      }
    }
    console.log(`feed catalog valid: ${catalog.feeds.length} feed(s), ${chain.length} signed release(s)`);
    return 0;
  }

  if (args.publish) {
    const channel = args.channel ?? 'production';
    if (!['sandbox', 'staging', 'production'].includes(channel)) {
      console.error('--channel must be sandbox, staging, or production');
      return 2;
    }
    if (!args.keyId) {
      console.error('--key-id is required so provenance identifies the signing key');
      return 2;
    }
    const privateKeyPem = await readPem(args.key ?? process.env.FEED_CATALOG_SIGNING_KEY, 'signing key');
    if (!privateKeyPem) {
      console.error('no signing key: pass --key <pem path> or set FEED_CATALOG_SIGNING_KEY');
      return 2;
    }
    const result = await publishRelease({
      catalogPath: args.catalog,
      releasesDir: args.releasesDir,
      privateKeyPem,
      keyId: args.keyId,
      channel,
      publishedAt: args.publishedAt ?? new Date().toISOString(),
      builder: [
        process.env.GITHUB_REPOSITORY,
        process.env.GITHUB_SHA,
        process.env.GITHUB_RUN_ID,
        process.env.GITHUB_ACTOR,
      ]
        .filter(Boolean)
        .join(':') || 'local',
    });
    if (!result.ok) {
      printErrors(result.errors);
      return 1;
    }
    console.log(`published ${path.relative(ROOT, result.file)}`);
    console.log(JSON.stringify(result.release.provenance, null, 2));
    return 0;
  }

  if (args.verify) {
    const chain = await loadReleaseChain(args.releasesDir);
    if (chain.length === 0) {
      console.error(`no signed releases found in ${args.releasesDir}`);
      return 1;
    }
    const publicKeyPem = await readPem(args.publicKey, 'public key');
    const result = verifyReleaseChain(chain, { publicKeyPem, expectedChannel: args.channel });
    if (!result.valid) {
      printErrors(result.errors);
      return 1;
    }
    console.log(`verified ${chain.length} release(s); latest v${chain.at(-1).payload.version}`);
    return 0;
  }

  if (args.provenance) {
    const chain = await loadReleaseChain(args.releasesDir);
    if (chain.length === 0) {
      console.error(`no signed releases found in ${args.releasesDir}`);
      return 1;
    }
    const latest = chain.at(-1);
    console.log(
      JSON.stringify(
        {
          version: latest.payload.version,
          channel: latest.payload.channel,
          publishedAt: latest.payload.publishedAt,
          catalogHash: latest.payload.catalogHash,
          previousCatalogHash: latest.payload.previousCatalogHash,
          ...latest.provenance,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.error('nothing to do; pass --check, --publish, --verify or --provenance');
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
