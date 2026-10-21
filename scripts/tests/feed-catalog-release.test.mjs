import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  publishRelease,
  sha256,
  signRelease,
  validateCatalog,
  verifyRelease,
  verifyReleaseChain,
} from '../lib/feed-catalog-release.mjs';

const catalog = (overrides = {}) => ({
  schemaVersion: 2,
  network: 'stellar:pubnet',
  feeds: [
    {
      schemaVersion: 2,
      feedId: 'btc-usd',
      network: 'stellar:pubnet',
      base: { asset: 'BTC', issuer: null, decimals: 8 },
      quote: { asset: 'USD', issuer: null, decimals: 2 },
      precision: 7,
      eligibleSources: [{ source: 'chainlink', weightBps: 10000, required: true }],
      freshness: { heartbeatSeconds: 30, maxStalenessSeconds: 120 },
      ownership: { team: 'market-data', owner: 'feeds@example.com', oncall: 'pagerduty:market-data' },
      lifecycle: { state: 'active', since: '2026-01-01T00:00:00Z' },
      ...overrides,
    },
  ],
});

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

test('catalog validation accepts a complete catalog and rejects duplicates and bad freshness', () => {
  assert.deepEqual(validateCatalog(catalog()), []);
  const duplicate = catalog();
  duplicate.feeds.push(structuredClone(duplicate.feeds[0]));
  assert.ok(validateCatalog(duplicate).some((error) => /duplicate feedId/.test(error.message)));
  const inverted = catalog({ freshness: { heartbeatSeconds: 60, maxStalenessSeconds: 30 } });
  assert.ok(validateCatalog(inverted).some((error) => /heartbeatSeconds/.test(error.message)));
});

test('signs a release and verifies catalog hash and provenance', () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const signed = signRelease({
    catalog: catalog(),
    version: 1,
    channel: 'staging',
    publishedAt: '2026-05-01T00:00:00.000Z',
    privateKeyPem,
    keyId: 'test-key',
    builder: 'test',
  });
  assert.equal(signed.ok, true);
  assert.equal(signed.release.provenance.digest, sha256(signed.release.payload));
  const result = verifyRelease(signed.release, { publicKeyPem, expectedChannel: 'staging' });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('rejects tampered catalog content and a wrong public key', () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const signed = signRelease({
    catalog: catalog(),
    version: 1,
    channel: 'production',
    publishedAt: '2026-05-01T00:00:00.000Z',
    privateKeyPem,
    keyId: 'test-key',
  });
  const tampered = structuredClone(signed.release);
  tampered.payload.catalog.feeds[0].precision = 2;
  const hashResult = verifyRelease(tampered, { publicKeyPem });
  assert.equal(hashResult.valid, false);
  assert.ok(hashResult.errors.some((error) => error.path === '$.payload.catalogHash'));

  const otherKey = keyPair();
  const wrongKey = verifyRelease(signed.release, { publicKeyPem: otherKey.publicKeyPem });
  assert.equal(wrongKey.valid, false);
  assert.ok(wrongKey.errors.some((error) => /signature/.test(error.path)));
});

test('publishes immutable sequential releases and verifies the chain', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'feed-catalog-release-'));
  const releasesDir = path.join(dir, 'releases');
  const catalogPath = path.join(dir, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify(catalog()));
  const { privateKeyPem, publicKeyPem } = keyPair();

  const first = await publishRelease({
    catalogPath,
    releasesDir,
    privateKeyPem,
    keyId: 'test-key',
    channel: 'staging',
    publishedAt: '2026-05-01T00:00:00.000Z',
  });
  assert.equal(first.ok, true, JSON.stringify(first.errors));

  const second = await publishRelease({
    catalogPath,
    releasesDir,
    privateKeyPem,
    keyId: 'test-key',
    channel: 'staging',
    publishedAt: '2026-05-02T00:00:00.000Z',
  });
  assert.equal(second.ok, true, JSON.stringify(second.errors));

  const releases = [
    JSON.parse(await readFile(path.join(releasesDir, 'v1.json'), 'utf8')),
    JSON.parse(await readFile(path.join(releasesDir, 'v2.json'), 'utf8')),
  ];
  const chain = verifyReleaseChain(releases, { publicKeyPem, expectedChannel: 'staging' });
  assert.equal(chain.valid, true, JSON.stringify(chain.errors));

  const tamperedChain = structuredClone(releases);
  tamperedChain[1].payload.previousCatalogHash = '0'.repeat(64);
  const broken = verifyReleaseChain(tamperedChain, { publicKeyPem });
  assert.equal(broken.valid, false);
});

test('publishes a new version rather than overwriting an existing artifact', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'feed-catalog-immutable-'));
  const releasesDir = path.join(dir, 'releases');
  const catalogPath = path.join(dir, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify(catalog()));
  const { privateKeyPem } = keyPair();
  const args = {
    catalogPath,
    releasesDir,
    privateKeyPem,
    keyId: 'test-key',
    channel: 'production',
    publishedAt: '2026-05-01T00:00:00.000Z',
  };
  assert.equal((await publishRelease(args)).ok, true);
  const original = await readFile(path.join(releasesDir, 'v1.json'), 'utf8');
  const again = await publishRelease({ ...args, publishedAt: '2026-05-02T00:00:00.000Z' });
  assert.equal(again.ok, true);
  assert.equal(again.release.payload.version, 2);
  assert.equal(await readFile(path.join(releasesDir, 'v1.json'), 'utf8'), original);
  const invalidVersion = signRelease({
    catalog: catalog(),
    version: 1,
    channel: 'production',
    previousCatalogHash: 'a'.repeat(64),
    publishedAt: '2026-05-01T00:00:00.000Z',
    privateKeyPem,
    keyId: 'test-key',
  });
  assert.equal(invalidVersion.ok, false);
});

test('refuses to sign an invalid catalog', () => {
  const { privateKeyPem } = keyPair();
  const result = signRelease({
    catalog: catalog({ feedId: 'BTC/USD' }),
    version: 1,
    channel: 'staging',
    publishedAt: '2026-05-01T00:00:00.000Z',
    privateKeyPem,
    keyId: 'test-key',
  });
  assert.equal(result.ok, false);
});
