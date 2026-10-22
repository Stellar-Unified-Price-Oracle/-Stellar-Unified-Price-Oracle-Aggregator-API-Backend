export interface BiasEstimate { meanPercent: number; lower95: number; upper95: number; observations: number; significant: boolean; }

export class SourceBiasTracker {
  private readonly history = new Map<string, number[]>();
  constructor(private readonly windowSize = 30, private readonly minObservations = 10, private readonly thresholdPercent = 1) {}

  observe(asset: string, source: string, sourcePrice: number, independentPrices: number[]): BiasEstimate | null {
    const peers = independentPrices.filter((price) => Number.isFinite(price) && price > 0).sort((a, b) => a - b);
    if (peers.length < 2 || !Number.isFinite(sourcePrice) || sourcePrice <= 0) return null;
    const mid = Math.floor(peers.length / 2);
    const reference = peers.length % 2 ? peers[mid] : (peers[mid - 1] + peers[mid]) / 2;
    const key = `${asset.toUpperCase()}:${source}`;
    const values = this.history.get(key) ?? [];
    values.push((sourcePrice - reference) / reference * 100);
    if (values.length > this.windowSize) values.shift();
    this.history.set(key, values);
    if (values.length < this.minObservations) return null;
    const meanPercent = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - meanPercent) ** 2, 0) / (values.length - 1);
    const margin = 1.96 * Math.sqrt(variance / values.length);
    const lower95 = meanPercent - margin, upper95 = meanPercent + margin;
    return { meanPercent, lower95, upper95, observations: values.length,
      significant: (lower95 > this.thresholdPercent || upper95 < -this.thresholdPercent) };
  }
}
