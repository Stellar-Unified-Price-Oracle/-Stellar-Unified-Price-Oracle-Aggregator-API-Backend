// API usage analytics: per-endpoint/key/asset tracking, periodic reports, anomaly detection.

export interface UsageEvent {
  endpoint: string;
  method: string;
  apiKeyPrefix: string;
  asset?: string;
  status: number;
  timestamp: number;
}

interface Bucket {
  count: number;
  byEndpoint: Map<string, number>;
  byKey: Map<string, number>;
  byAsset: Map<string, number>;
}

function newBucket(): Bucket {
  return { count: 0, byEndpoint: new Map(), byKey: new Map(), byAsset: new Map() };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

function topEntries(map: Map<string, number>, n = 10): Array<{ key: string; count: number }> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

const HOUR_MS = 60 * 60 * 1000;
const MAX_HOURLY_BUCKETS = 24 * 90; // 90 days of hourly buckets

class UsageAnalytics {
  // hourly bucket key (ms since epoch, floored to hour) -> Bucket
  private hourly = new Map<number, Bucket>();
  private events: UsageEvent[] = [];
  private readonly maxEvents = 5000;

  record(event: UsageEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();

    const hourKey = Math.floor(event.timestamp / HOUR_MS) * HOUR_MS;
    let bucket = this.hourly.get(hourKey);
    if (!bucket) {
      bucket = newBucket();
      this.hourly.set(hourKey, bucket);
      if (this.hourly.size > MAX_HOURLY_BUCKETS) {
        const oldestKey = Math.min(...this.hourly.keys());
        this.hourly.delete(oldestKey);
      }
    }
    bucket.count += 1;
    bump(bucket.byEndpoint, `${event.method} ${event.endpoint}`);
    bump(bucket.byKey, event.apiKeyPrefix);
    if (event.asset) bump(bucket.byAsset, event.asset);
  }

  private aggregate(sinceMs: number): Bucket {
    const merged = newBucket();
    for (const [hourKey, bucket] of this.hourly) {
      if (hourKey < sinceMs) continue;
      merged.count += bucket.count;
      for (const [k, v] of bucket.byEndpoint) merged.byEndpoint.set(k, (merged.byEndpoint.get(k) || 0) + v);
      for (const [k, v] of bucket.byKey) merged.byKey.set(k, (merged.byKey.get(k) || 0) + v);
      for (const [k, v] of bucket.byAsset) merged.byAsset.set(k, (merged.byAsset.get(k) || 0) + v);
    }
    return merged;
  }

  report(period: 'daily' | 'weekly' | 'monthly'): Record<string, unknown> {
    const now = Date.now();
    const windowMs =
      period === 'daily' ? 24 * HOUR_MS : period === 'weekly' ? 7 * 24 * HOUR_MS : 30 * 24 * HOUR_MS;
    const bucket = this.aggregate(now - windowMs);

    return {
      period,
      generatedAt: Math.floor(now / 1000),
      windowStart: Math.floor((now - windowMs) / 1000),
      totalRequests: bucket.count,
      topEndpoints: topEntries(bucket.byEndpoint),
      topKeys: topEntries(bucket.byKey),
      topAssets: topEntries(bucket.byAsset),
    };
  }

  dashboard(): Record<string, unknown> {
    return {
      last24h: this.report('daily'),
      last7d: this.report('weekly'),
      last30d: this.report('monthly'),
      recentEvents: this.events.slice(-50),
    };
  }

  /**
   * Flags hours whose request count deviates more than `stdDevThreshold`
   * standard deviations from the trailing mean (z-score anomaly detection).
   */
  detectAnomalies(stdDevThreshold = 3, lookbackHours = 24 * 7): Array<{
    hour: string;
    count: number;
    mean: number;
    stdDev: number;
    zScore: number;
  }> {
    const now = Date.now();
    const cutoff = now - lookbackHours * HOUR_MS;
    const points = Array.from(this.hourly.entries())
      .filter(([hourKey]) => hourKey >= cutoff)
      .sort((a, b) => a[0] - b[0])
      .map(([hourKey, bucket]) => ({ hourKey, count: bucket.count }));

    if (points.length < 4) return [];

    const counts = points.map((p) => p.count);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((acc, c) => acc + (c - mean) ** 2, 0) / counts.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return [];

    const anomalies: Array<{ hour: string; count: number; mean: number; stdDev: number; zScore: number }> = [];
    for (const p of points) {
      const zScore = (p.count - mean) / stdDev;
      if (Math.abs(zScore) >= stdDevThreshold) {
        anomalies.push({
          hour: new Date(p.hourKey).toISOString(),
          count: p.count,
          mean: Math.round(mean * 100) / 100,
          stdDev: Math.round(stdDev * 100) / 100,
          zScore: Math.round(zScore * 100) / 100,
        });
      }
    }
    return anomalies;
  }
}

export const usageAnalytics = new UsageAnalytics();
