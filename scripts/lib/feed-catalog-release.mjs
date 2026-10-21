import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_SCHEMA_VERSION = 1;
export const CATALOG_SCHEMA_MAJOR = 2;
const NETWORKS = ['stellar:pubnet', 'stellar:testnet', 'stellar:futurenet'];
const SOURCES = ['chainlink', 'redstone', 'band', 'reflector'];
const STATES = ['proposed', 'canary', 'active', 'paused', 'deprecated', 'retired'];

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value), 'utf8').digest('hex');
}

export function validateCatalog(catalog) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return [{ path: '$', message: 'catalog must be an object' }];
  }
  if (catalog.schemaVersion !== CATALOG_SCHEMA_MAJOR) {
    fail('$.schemaVersion', `schemaVersion must be ${CATALOG_SCHEMA_MAJOR}`);
  }
  if (!NETWORKS.includes(catalog.network)) {
    fail('$.network', `network must be one of: ${NETWORKS.join(', ')}`);
  }
  if (!Array.isArray(catalog.feeds) || catalog.feeds.length === 0) {
    fail('$.feeds', 'feeds must be a non-empty array');
    return errors;
  }
  const ids = new Set();
  catalog.feeds.forEach((feed, index) => {
    const at = `$.feeds[${index}]`;
    if (!feed || typeof feed !== 'object') {
      fail(at, 'feed must be an object');
      return;
    }
    if (feed.schemaVersion !== CATALOG_SCHEMA_MAJOR) {
      fail(`${at}.schemaVersion`, `feed schemaVersion must be ${CATALOG_SCHEMA_MAJOR}`);
    }
    if (typeof feed.feedId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feed.feedId)) {
      fail(`${at}.feedId`, 'feedId must be lower-case kebab-case');
    } else if (ids.has(feed.feedId)) {
      fail(`${at}.feedId`, `duplicate feedId "${feed.feedId}"`);
    } else {
      ids.add(feed.feedId);
    }
    for (const unit of ['base', 'quote']) {
      const value = feed[unit];
      if (!value || typeof value.asset !== 'string' || value.asset.length === 0) {
        fail(`${at}.${unit}.asset`, 'asset is required');
      }
      if (!Number.isInteger(value?.decimals) || value.decimals < 0 || value.decimals > 18) {
        fail(`${at}.${unit}.decimals`, 'decimals must be an integer between 0 and 18');
      }
    }
    if (!Number.isInteger(feed.precision) || feed.precision < 0 || feed.precision > 18) {
      fail(`${at}.precision`, 'precision must be an integer between 0 and 18');
    }
    if (!Array.isArray(feed.eligibleSources) || feed.eligibleSources.length === 0) {
      fail(`${at}.eligibleSources`, 'at least one eligible source is required');
    } else {
      const seen = new Set();
      feed.eligibleSources.forEach((entry, sourceIndex) => {
        const sourceAt = `${at}.eligibleSources[${sourceIndex}]`;
        if (!SOURCES.includes(entry?.source)) {
          fail(`${sourceAt}.source`, `source must be one of: ${SOURCES.join(', ')}`);
        } else if (seen.has(entry.source)) {
          fail(`${sourceAt}.source`, `duplicate source "${entry.source}"`);
        } else {
          seen.add(entry.source);
        }
        if (!Number.isInteger(entry?.weightBps) || entry.weightBps < 0 || entry.weightBps > 10000) {
          fail(`${sourceAt}.weightBps`, 'weightBps must be between 0 and 10000');
        }
        if (typeof entry?.required !== 'boolean') {
          fail(`${sourceAt}.required`, 'required must be a boolean');
        }
      });
    }
    const freshness = feed.freshness;
    if (!freshness || !Number.isInteger(freshness.heartbeatSeconds) || freshness.heartbeatSeconds < 1) {
      fail(`${at}.freshness.heartbeatSeconds`, 'heartbeatSeconds must be a positive integer');
    }
    if (!freshness || !Number.isInteger(freshness.maxStalenessSeconds) || freshness.maxStalenessSeconds < 1) {
      fail(`${at}.freshness.maxStalenessSeconds`, 'maxStalenessSeconds must be a positive integer');
    } else if (freshness && freshness.maxStalenessSeconds < freshness.heartbeatSeconds) {
      fail(`${at}.freshness.maxStalenessSeconds`, 'maxStalenessSeconds must be >= heartbeatSeconds');
    }
    const ownership = feed.ownership;
    for (const field of ['team', 'owner', 'oncall']) {
      if (typeof ownership?.[field] !== 'string' || ownership[field].length === 0) {
        fail(`${at}.ownership.${field}`, `${field} is required`);
      }
    }
    const lifecycle = feed.lifecycle;
    if (!STATES.includes(lifecycle?.state)) {
      fail(`${at}.lifecycle.state`, `state must be one of: ${STATES.join(', ')}`);
    }
    if (typeof lifecycle?.since !== 'string' || Number.isNaN(Date.parse(lifecycle.since))) {
      fail(`${at}.lifecycle.since`, 'since must be an ISO-8601 timestamp');
    }
    if (['deprecated', 'retired'].includes(lifecycle?.state) && typeof lifecycle.successorFeedId !== 'string') {
      fail(`${at}.lifecycle.successorFeedId`, `${lifecycle.state} feeds must name a successor`);
    }
  });
  return errors;
}

export function computeCatalogHash(catalog) {
  return sha256(catalog);
}

function releasePayload({ version, channel, catalog, previousCatalogHash, publishedAt }) {
  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    version,
    channel,
    publishedAt,
    catalogHash: computeCatalogHash(catalog),
    previousCatalogHash: previousCatalogHash ?? null,
    catalog,
  };
}

export function signRelease({ catalog, version, channel, previousCatalogHash, publishedAt, privateKeyPem, keyId, builder }) {
  const errors = validateCatalog(catalog);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, errors: [{ path: '$.version', message: 'version must be a positive integer' }] };
  }
  if (previousCatalogHash && version === 1) {
    return { ok: false, errors: [{ path: '$.version', message: 'version 1 cannot have a previous catalog hash' }] };
  }
  const payload = releasePayload({
    version,
    channel,
    catalog,
    previousCatalogHash,
    publishedAt,
  });
  const digest = sha256(payload);
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(digest, 'utf8'), key).toString('base64');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  return {
    ok: true,
    release: {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      payload,
      provenance: {
        generator: 'scripts/feed-catalog-release.mjs',
        builder: builder ?? 'local',
        keyId,
        algorithm: 'ed25519',
        publicKey,
        digest,
        signature,
        signatureScope: 'sha256(canonical-json(payload))',
      },
    },
  };
}

export function verifyRelease(release, { publicKeyPem, previousRelease, expectedChannel } = {}) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!release || typeof release !== 'object') {
    return { valid: false, errors: [{ path: '$', message: 'release must be an object' }] };
  }
  if (release.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    fail('$.schemaVersion', `unsupported release schema ${release.schemaVersion}`);
  }
  const { payload, provenance } = release;
  if (!payload || !provenance) {
    return { valid: false, errors: [{ path: '$', message: 'payload and provenance are required' }] };
  }
  if (expectedChannel && payload.channel !== expectedChannel) {
    fail('$.payload.channel', `expected channel "${expectedChannel}", found "${payload.channel}"`);
  }
  const catalogErrors = validateCatalog(payload.catalog);
  errors.push(...catalogErrors.map((error) => ({ path: `$.payload.catalog${error.path.slice(1)}`, message: error.message })));
  const actualHash = computeCatalogHash(payload.catalog);
  if (actualHash !== payload.catalogHash) {
    fail('$.payload.catalogHash', `catalog hash mismatch: payload says ${payload.catalogHash}, computed ${actualHash}`);
  }
  if (provenance.algorithm !== 'ed25519') {
    fail('$.provenance.algorithm', `unsupported algorithm "${provenance.algorithm}"`);
  }
  const digest = sha256(payload);
  if (provenance.digest !== digest) {
    fail('$.provenance.digest', 'payload digest does not match provenance');
  }
  const keyPem = publicKeyPem ?? provenance.publicKey;
  try {
    const valid = verify(
      null,
      Buffer.from(digest, 'utf8'),
      createPublicKey(keyPem),
      Buffer.from(provenance.signature, 'base64'),
    );
    if (!valid) fail('$.provenance.signature', 'signature does not verify');
  } catch (error) {
    fail('$.provenance.signature', `signature verification failed: ${error.message}`);
  }
  if (previousRelease) {
    if (payload.version !== previousRelease.payload.version + 1) {
      fail('$.payload.version', `expected version ${previousRelease.payload.version + 1}, found ${payload.version}`);
    }
    if (payload.previousCatalogHash !== previousRelease.payload.catalogHash) {
      fail('$.payload.previousCatalogHash', 'previousCatalogHash does not match the previous release');
    }
    if (Date.parse(payload.publishedAt) <= Date.parse(previousRelease.payload.publishedAt)) {
      fail('$.payload.publishedAt', 'publishedAt must increase monotonically');
    }
  } else if (payload.version !== 1) {
    fail('$.payload.version', 'the first release in a chain must be version 1');
  }
  return { valid: errors.length === 0, errors, release };
}

export async function readRelease(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function loadReleaseChain(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => /^v\d+\.json$/.test(entry))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
  return Promise.all(files.map((file) => readRelease(path.join(directory, file))));
}

export function verifyReleaseChain(releases, options = {}) {
  const errors = [];
  releases.forEach((release, index) => {
    const result = verifyRelease(release, {
      publicKeyPem: options.publicKeyPem,
      previousRelease: index === 0 ? undefined : releases[index - 1],
      expectedChannel: options.expectedChannel,
    });
    for (const error of result.errors) errors.push({ release: index + 1, ...error });
  });
  return { valid: errors.length === 0, errors };
}

export async function publishRelease({
  catalogPath,
  releasesDir,
  privateKeyPem,
  keyId,
  channel,
  publishedAt,
  builder,
  publicKeyPem,
}) {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const chain = await loadReleaseChain(releasesDir);
  const previous = chain.at(-1);
  const version = (previous?.payload.version ?? 0) + 1;
  const result = signRelease({
    catalog,
    version,
    channel,
    previousCatalogHash: previous?.payload.catalogHash,
    publishedAt,
    privateKeyPem,
    keyId,
    builder,
  });
  if (!result.ok) return result;
  const verification = verifyRelease(result.release, {
    publicKeyPem,
    previousRelease: previous,
    expectedChannel: channel,
  });
  if (!verification.valid) return { ok: false, errors: verification.errors };
  await mkdir(releasesDir, { recursive: true });
  const file = path.join(releasesDir, `v${version}.json`);
  try {
    await writeFile(file, `${JSON.stringify(result.release, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return { ok: false, errors: [{ path: file, message: 'release artifacts are immutable and already exist' }] };
    }
    throw error;
  }
  return { ok: true, file, release: result.release };
}
