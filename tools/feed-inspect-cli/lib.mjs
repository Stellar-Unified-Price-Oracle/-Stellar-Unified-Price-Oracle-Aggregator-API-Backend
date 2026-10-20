// Pure helpers for the feed inspection CLI (no I/O except the injected fetch).

export function normalizeFeedId(input) {
  if (typeof input !== 'string') throw new Error('feed identifier must be a string');
  const id = input.trim().toUpperCase().replace(/[-_\s]/g, '/');
  if (!/^[A-Z0-9]{1,12}\/[A-Z0-9]{1,12}$/.test(id)) {
    throw new Error(`invalid feed identifier "${input}" (expected BASE/QUOTE, e.g. XLM/USD)`);
  }
  return id;
}

// Accepts epoch seconds, epoch milliseconds, or ISO strings. Returns ms or null.
export function toEpochMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? null : parsed;
}

export function evaluateFreshness(timestamp, maxAgeSec, nowMs = Date.now()) {
  const ms = toEpochMs(timestamp);
  if (ms === null) return { status: 'unknown', ageSec: null, maxAgeSec };
  const ageSec = Math.max(0, Math.round((nowMs - ms) / 1000));
  return { status: ageSec <= maxAgeSec ? 'fresh' : 'stale', ageSec, maxAgeSec };
}

const unwrap = (body) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

async function getJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, body };
}

export async function inspectFeed({ baseUrl, feed, fetchImpl = fetch, timeoutMs = 5000 }) {
  const id = normalizeFeedId(feed);
  const r = await getJson(fetchImpl, `${baseUrl}/api/v2/prices/${encodeURIComponent(id)}`, timeoutMs);
  if (r.status === 404) return { found: false, feed: id };
  if (!r.ok) throw new Error(`HTTP ${r.status} from price endpoint`);
  return { found: true, feed: id, data: unwrap(r.body) };
}

export async function checkFreshness({ baseUrl, feed, maxAgeSec = 60, fetchImpl, timeoutMs, nowMs }) {
  const info = await inspectFeed({ baseUrl, feed, fetchImpl, timeoutMs });
  if (!info.found) return { feed: info.feed, status: 'missing' };
  return { feed: info.feed, ...evaluateFreshness(info.data?.timestamp, maxAgeSec, nowMs) };
}

export async function checkConnectivity({ baseUrl, fetchImpl = fetch, timeoutMs = 5000 }) {
  const paths = ['/api/v2/health/live', '/api/v2/health/ready'];
  const results = [];
  for (const p of paths) {
    const t0 = Date.now();
    try {
      const r = await getJson(fetchImpl, `${baseUrl}${p}`, timeoutMs);
      results.push({ path: p, ok: r.ok, status: r.status, latencyMs: Date.now() - t0 });
    } catch (e) {
      results.push({ path: p, ok: false, status: null, latencyMs: Date.now() - t0, error: e.name });
    }
  }
  return { baseUrl, ok: results.every((r) => r.ok), results };
}
