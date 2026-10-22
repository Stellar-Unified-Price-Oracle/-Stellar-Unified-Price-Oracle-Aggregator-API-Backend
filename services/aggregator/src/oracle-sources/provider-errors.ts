export type ProviderErrorCategory =
  | 'authentication' | 'rate-limited' | 'timeout' | 'unavailable'
  | 'invalid-payload' | 'no-price' | 'budget-exhausted' | 'circuit-open'
  | 'policy-blocked' | 'unknown';

export interface ProviderFailure {
  category: ProviderErrorCategory;
  retryable: boolean;
}

export function providerFailure(category: ProviderErrorCategory): ProviderFailure {
  return { category, retryable: ['rate-limited', 'timeout', 'unavailable'].includes(category) };
}

export function classifyProviderError(error: unknown): ProviderFailure {
  const e = error as { code?: string; name?: string; response?: { status?: number } } | null;
  const status = e?.response?.status;
  if (e?.name === 'SsrfError' || e?.name === 'SandboxCredentialError') return providerFailure('policy-blocked');
  if (status === 401 || status === 403) return providerFailure('authentication');
  if (status === 429) return providerFailure('rate-limited');
  if (status === 404) return providerFailure('no-price');
  if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || status === 408 || status === 504) return providerFailure('timeout');
  if ((status !== undefined && status >= 500) || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e?.code ?? '')) return providerFailure('unavailable');
  return providerFailure('unknown');
}
