import * as crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { readAssetPrices } from '../price-store';
import { authMiddleware } from '../../governance/auth';
import { v2Ok, v2Fail } from '../../infrastructure/response';
import { SignedPriceSnapshot, TRUSTED_KEYS } from '../snapshot-verifier';
import { feedCatalogService } from '../../feeds/feed-service';
import { parseCanonicalAssetId } from '../../feeds/asset-identity';

const router = Router();

const CURRENT_KEY_ID = 'oracle-v1-primary';
const SCHEMA_VERSION = 2;

/**
 * Canonical payload for schemaVersion 2 — field order is fixed and must match
 * snapshot-verifier.ts exactly. Binds feed identity, price, precision,
 * observation time, catalog policy version and the signature key id.
 */
function canonicalPayload(snapshot: SignedPriceSnapshot): string {
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    feedId: snapshot.feedId ?? null,
    asset: snapshot.asset,
    price: snapshot.price,
    decimals: snapshot.decimals,
    timestamp: snapshot.timestamp,
    observedAt: snapshot.observedAt ?? null,
    policyVersion: snapshot.policyVersion ?? null,
    sources: snapshot.sources,
    keyId: snapshot.keyId,
  });
}

/**
 * Sign with the same trusted key material the verifier checks against, so a
 * snapshot signed here always round-trips through verifyPriceSnapshot.
 * Operators replace TRUSTED_KEYS with their published keys.
 */
function signSnapshot(snapshot: SignedPriceSnapshot): string {
  const key = TRUSTED_KEYS[snapshot.keyId];
  if (!key) throw new Error('unknown signing key: ' + snapshot.keyId);
  return crypto
    .createHmac('sha256', key.secret)
    .update(canonicalPayload(snapshot))
    .digest('hex');
}

function findPolicyForAsset(asset: string) {
  return feedCatalogService.listFeeds().find((policy) => {
    const parsed = parseCanonicalAssetId(policy.asset);
    if (parsed && parsed.code === asset) return true;
    return policy.feedId.toLowerCase() === asset.toLowerCase();
  });
}

router.get('/:asset', authMiddleware, async (req: Request, res: Response) => {
  const asset = req.params.asset.toUpperCase();
  const allPrices = await readAssetPrices();
  const prices = allPrices.filter((p) => p.asset === asset);
  if (!prices || prices.length === 0) {
    return res.status(404).json(
      v2Fail({ code: 'PRICE_NOT_FOUND', message: 'No price data for asset: ' + asset }),
    );
  }

  const latest = prices[prices.length - 1];
  const policy = findPolicyForAsset(asset);

  const snapshot: SignedPriceSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    feedId: policy?.feedId ?? asset.toLowerCase(),
    asset,
    price: latest.price,
    decimals: latest.decimals,
    timestamp: latest.timestamp,
    observedAt: latest.timestamp,
    policyVersion: policy?.version ?? 0,
    sources: latest.sources ?? [latest.source],
    keyId: CURRENT_KEY_ID,
    signature: '',
  };
  snapshot.signature = signSnapshot(snapshot);

  return res.json(v2Ok(snapshot));
});

router.get('/', authMiddleware, async (_req: Request, res: Response) => {
  const allPrices = await readAssetPrices();
  return res.json(
    v2Ok({
      assets: allPrices.map((p) => p.asset),
      schemaVersion: SCHEMA_VERSION,
      keyId: CURRENT_KEY_ID,
      note: 'Use GET /consumer/snapshots/:asset to retrieve a signed snapshot',
    }),
  );
});

export default router;
