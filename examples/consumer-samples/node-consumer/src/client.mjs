// Feed discovery, price verification and error handling.
export class OracleError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function verifyPrice(p, { now = Date.now() / 1000, maxAgeSec = 60 } = {}) {
  if (typeof p?.price !== 'string' || !/^\d+$/.test(p.price)) throw new OracleError(0, 'BAD_PRICE_ENCODING', 'price must be a string integer');
  if (!Number.isInteger(p.decimals) || p.decimals < 0) throw new OracleError(0, 'BAD_DECIMALS', 'decimals invalid');
  if (BigInt(p.price) === 0n) throw new OracleError(0, 'ZERO_PRICE', 'zero price rejected');
  if (now - p.timestamp > maxAgeSec) throw new OracleError(0, 'STALE_PRICE', `price older than ${maxAgeSec}s`);
  return { ...p, value: BigInt(p.price) };
}

export function createClient(cfg, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  async function request(path) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(cfg.baseUrl + path, {
          headers: cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {},
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (e) {
        if (attempt >= cfg.maxRetries) throw new OracleError(0, 'NETWORK', e.message);
        await sleep(2 ** attempt * 200); continue;
      }
      if (res.ok) return res.json();
      const body = await res.json().catch(() => ({}));
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= cfg.maxRetries) throw new OracleError(res.status, body.code ?? 'UNKNOWN', body.message ?? res.statusText);
      const retryAfter = Number(res.headers.get?.('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 200);
    }
  }
  return {
    discoverSources: () => request('/api/v1/sources'),
    getPrice: async (asset) => verifyPrice(await request(`/api/v1/prices/${encodeURIComponent(asset)}`), { maxAgeSec: cfg.maxPriceAgeSec }),
  };
}
