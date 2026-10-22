import type { NormalizedPrice } from '../infrastructure/types';
import { capabilityRegistry } from './capabilities';
import {
  oracleFeedConcentrationAlertsTotal,
  oracleFeedProviderCount,
  oracleFeedProviderHhi,
  oracleFeedMaxDependencyShare,
  oracleProviderCadenceSeconds,
  oracleShadowDeviationPercent,
  oracleShadowObservationsTotal,
  oracleSourceFreshnessSeconds,
} from '../observability/metrics';
import { sanitizeAssetLabel, sanitizeSourceLabel } from '../observability/cardinality';

export interface ConcentrationReport {
  asset: string;
  providerCount: number;
  dependencyGroupCount: number;
  hhi: number;
  maxDependencyShare: number;
  healthy: boolean;
  reasons: string[];
}

export function assessProviderConcentration(
  asset: string,
  sourceNames: string[],
  policy = { minimumDependencyGroups: 2, maximumDependencyShare: 0.75, maximumHhi: 0.6 },
): ConcentrationReport {
  const groups = new Map<string, number>();
  for (const source of new Set(sourceNames)) {
    const dependency = capabilityRegistry.getCapabilities(source as NormalizedPrice['source'])?.dependencyGroup ?? source;
    groups.set(dependency, (groups.get(dependency) ?? 0) + 1);
  }
  const providerCount = new Set(sourceNames).size;
  const dependencyGroupCount = groups.size;
  const total = Array.from(groups.values()).reduce((sum, n) => sum + n, 0);
  const shares = total === 0 ? [] : Array.from(groups.values(), (n) => n / total);
  const hhi = shares.reduce((sum, share) => sum + share * share, 0);
  const maxDependencyShare = Math.max(0, ...shares);
  const reasons: string[] = [];
  if (dependencyGroupCount < policy.minimumDependencyGroups) reasons.push('insufficient_dependency_groups');
  if (maxDependencyShare > policy.maximumDependencyShare) reasons.push('dependency_share_over_policy');
  if (hhi > policy.maximumHhi) reasons.push('hhi_over_policy');
  return { asset: asset.toUpperCase(), providerCount, dependencyGroupCount, hhi, maxDependencyShare, healthy: reasons.length === 0, reasons };
}

export function recordProviderConcentration(report: ConcentrationReport): void {
  const asset = sanitizeAssetLabel(report.asset);
  oracleFeedProviderCount.set({ asset }, report.dependencyGroupCount);
  oracleFeedProviderHhi.set({ asset }, report.hhi);
  oracleFeedMaxDependencyShare.set({ asset }, report.maxDependencyShare);
  for (const reason of report.reasons) oracleFeedConcentrationAlertsTotal.inc({ asset, reason });
}

export function recordProviderFreshness(price: NormalizedPrice, nowMs = Date.now()): number {
  const source = sanitizeSourceLabel(price.source);
  const asset = sanitizeAssetLabel(price.asset);
  const observedAt = price.observedAt ?? price.fetchedAt ?? price.timestamp;
  const ageSeconds = Math.max(0, nowMs / 1000 - observedAt);
  oracleSourceFreshnessSeconds.set({ source, asset }, ageSeconds);
  const cadence = capabilityRegistry.getCapabilities(price.source)?.updateCadenceMs;
  if (cadence !== undefined) oracleProviderCadenceSeconds.set({ source, asset }, cadence / 1000);
  return ageSeconds;
}

export function parseShadowSources(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((source) => source.trim().toLowerCase()).filter(Boolean));
}

export function recordShadowObservation(
  shadow: NormalizedPrice,
  active: NormalizedPrice[],
): { compared: boolean; deviationPercent?: number } {
  const source = sanitizeSourceLabel(shadow.source);
  const asset = sanitizeAssetLabel(shadow.asset);
  if (active.length === 0) {
    oracleShadowObservationsTotal.inc({ source, asset, result: 'no_active_reference' });
    return { compared: false };
  }
  const values = active.map((price) => Number(price.price) / 10 ** price.decimals).filter(Number.isFinite).sort((a, b) => a - b);
  const shadowValue = Number(shadow.price) / 10 ** shadow.decimals;
  if (values.length === 0 || !Number.isFinite(shadowValue)) {
    oracleShadowObservationsTotal.inc({ source, asset, result: 'invalid_comparison' });
    return { compared: false };
  }
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  if (median === 0 && shadowValue !== 0) {
    oracleShadowObservationsTotal.inc({ source, asset, result: 'invalid_comparison' });
    return { compared: false };
  }
  const deviationPercent = median === 0 ? 0 : Math.abs(shadowValue - median) / Math.abs(median) * 100;
  oracleShadowObservationsTotal.inc({ source, asset, result: 'compared' });
  oracleShadowDeviationPercent.set({ source, asset }, deviationPercent);
  return { compared: true, deviationPercent };
}
