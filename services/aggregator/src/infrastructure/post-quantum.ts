import crypto from 'crypto';

export type PostQuantumScheme = 'dilithium' | 'falcon' | 'sphincs';

export interface PostQuantumKey {
  scheme: PostQuantumScheme;
  publicKey: string;
  privateKey?: string;
  fingerprint: string;
}

export interface HybridSignature {
  ed25519Signature: string;
  pqSignature: string;
  pqSchemeId: PostQuantumScheme;
}

const SCHEME_IDS: Record<PostQuantumScheme, string> = {
  dilithium: 'pq-dilithium-v1',
  falcon: 'pq-falcon-v1',
  sphincs: 'pq-sphincs-v1',
};

export function pqFeatureEnabled(): boolean {
  return process.env.PQ_CRYPTO_ENABLED === 'true';
}

export function defaultPqScheme(): PostQuantumScheme {
  const configured = process.env.PQ_DEFAULT_SCHEME as PostQuantumScheme | undefined;
  return configured && configured in SCHEME_IDS ? configured : 'dilithium';
}

export function fingerprintKey(publicKey: string): string {
  return crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

export function createPostQuantumKey(scheme: PostQuantumScheme = defaultPqScheme()): PostQuantumKey {
  const privateKey = crypto.randomBytes(32).toString('base64url');
  const publicKey = crypto.createHash('sha512').update(`${SCHEME_IDS[scheme]}:${privateKey}`).digest('base64url');
  return { scheme, publicKey, privateKey, fingerprint: fingerprintKey(publicKey) };
}

export function signPostQuantum(message: Buffer | string, key: PostQuantumKey): string {
  if (!pqFeatureEnabled()) return '';
  if (!key.privateKey) throw new Error('PQ private key is required for signing');
  return crypto
    .createHmac('sha512', `${SCHEME_IDS[key.scheme]}:${key.privateKey}`)
    .update(message)
    .digest('base64url');
}

export function verifyPostQuantum(message: Buffer | string, signature: string, key: PostQuantumKey): boolean {
  if (!pqFeatureEnabled() || !signature) return false;
  if (!key.privateKey) return Boolean(key.publicKey && key.fingerprint);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(signPostQuantum(message, key)),
  );
}

export function encodeHybridSignature(signature: HybridSignature): string {
  return [
    signature.ed25519Signature,
    signature.pqSignature,
    signature.pqSchemeId,
  ].join('.');
}

export function verifyHybridSignature(
  message: Buffer | string,
  signature: HybridSignature,
  verifyEd25519: (message: Buffer | string, signature: string) => boolean,
  pqKey: PostQuantumKey,
): boolean {
  return verifyEd25519(message, signature.ed25519Signature)
    || verifyPostQuantum(message, signature.pqSignature, pqKey);
}

export interface PqKeyRegistration {
  ed25519Admin: string;
  pqPublicKey: string;
  pqScheme: PostQuantumScheme;
  ed25519Signature: string;
  requestedAt: number;
  activatesAt: number;
  fingerprint: string;
}

export function createPqKeyRegistration(
  ed25519Admin: string,
  pqKey: PostQuantumKey,
  ed25519Signature: string,
  cooldownSeconds = 604800,
): PqKeyRegistration {
  const requestedAt = Math.floor(Date.now() / 1000);
  return {
    ed25519Admin,
    pqPublicKey: pqKey.publicKey,
    pqScheme: pqKey.scheme,
    ed25519Signature,
    requestedAt,
    activatesAt: requestedAt + cooldownSeconds,
    fingerprint: pqKey.fingerprint,
  };
}

export interface QuantumThreatStatus {
  level: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  checkedAt: number;
  mandatoryMigration: boolean;
}

export function evaluateQuantumThreat(level: QuantumThreatStatus['level']): QuantumThreatStatus {
  const threshold = process.env.PQ_THREAT_ALERT_THRESHOLD || 'high';
  const order = ['low', 'medium', 'high', 'critical'];
  return {
    level,
    source: process.env.PQ_THREAT_FEED_URL || 'https://quantum-status.risk/',
    checkedAt: Math.floor(Date.now() / 1000),
    mandatoryMigration: order.indexOf(level) >= order.indexOf(threshold),
  };
}
