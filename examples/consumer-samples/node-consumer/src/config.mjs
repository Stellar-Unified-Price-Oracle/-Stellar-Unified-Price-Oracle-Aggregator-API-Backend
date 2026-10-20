// Production-safe configuration: fail fast, no secrets in code, explicit timeouts.
export function loadConfig(env = process.env) {
  const baseUrl = env.ORACLE_BASE_URL;
  if (!baseUrl) throw new Error('ORACLE_BASE_URL is required');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('ORACLE_BASE_URL must use https outside localhost');
  const num = (k, d, min, max) => {
    const v = env[k] === undefined ? d : Number(env[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} must be between ${min} and ${max}`);
    return v;
  };
  return {
    baseUrl: url.origin,
    apiKey: env.ORACLE_API_KEY ?? null, // read from env/secret store, never commit
    timeoutMs: num('ORACLE_TIMEOUT_MS', 5000, 100, 30000),
    maxRetries: num('ORACLE_MAX_RETRIES', 3, 0, 5),
    maxPriceAgeSec: num('ORACLE_MAX_PRICE_AGE_SEC', 60, 1, 3600),
  };
}
