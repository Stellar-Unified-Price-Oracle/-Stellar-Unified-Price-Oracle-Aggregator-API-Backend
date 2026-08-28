export interface HybridTlsPolicy {
  enabled: boolean;
  classicalGroup: 'X25519';
  postQuantumGroup: 'ML-KEM-768' | 'ML-KEM-1024';
  minVersion: 'TLSv1.3';
  provider: 'openssl3-provider' | 'boringssl-experimental';
}

export function hybridTlsPolicyFromEnv(): HybridTlsPolicy {
  return {
    enabled: process.env.PQ_TLS_ENABLED === 'true',
    classicalGroup: 'X25519',
    postQuantumGroup: process.env.PQ_TLS_GROUP === 'ML-KEM-1024' ? 'ML-KEM-1024' : 'ML-KEM-768',
    minVersion: 'TLSv1.3',
    provider: process.env.PQ_TLS_PROVIDER === 'boringssl-experimental'
      ? 'boringssl-experimental'
      : 'openssl3-provider',
  };
}

export function assertHybridTlsRuntime(policy = hybridTlsPolicyFromEnv()): void {
  if (!policy.enabled) return;
  const runtime = process.versions.openssl || '';
  if (policy.provider === 'openssl3-provider' && !runtime.startsWith('3.')) {
    throw new Error('Hybrid PQ TLS requires Node linked against OpenSSL 3.x provider support');
  }
}
