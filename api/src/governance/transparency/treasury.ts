import type { Freshness } from './store';
import { describeFreshness } from './store';
import type { TreasuryEntry, TreasurySnapshot } from './schema';

export const TREASURY_POLICY_TOLERANCE_BPS = 500;

export interface TreasuryAmountView {
  minor: string;
  display: string;
}

export interface TreasuryAssetReconciliation {
  asset: string;
  decimals: number;
  openingBalance: TreasuryAmountView;
  inflows: TreasuryAmountView;
  outflows: TreasuryAmountView;
  expectedClosing: TreasuryAmountView;
  closingBalance: TreasuryAmountView;
  delta: TreasuryAmountView;
  reconciled: boolean;
  entryCount: number;
  inflowCount: number;
  outflowCount: number;
}

export interface TreasuryPolicyAllocation {
  policy: string;
  targetShareBps: number;
  actualShareBps: number;
  deviationBps: number;
  outflow: TreasuryAmountView;
  withinTolerance: boolean;
}

export interface TreasuryPolicyAllocationByAsset {
  asset: string;
  totalOutflow: TreasuryAmountView;
  allocations: TreasuryPolicyAllocation[];
}

export interface TreasuryLedgerRow {
  id: string;
  timestamp: string;
  direction: 'inflow' | 'outflow';
  asset: string;
  decimals: number | null;
  amount: TreasuryAmountView;
  category: string;
  policy: string;
  source: TreasuryEntry['source'] | null;
  counterparty: string | null;
  memo: string | null;
}

export interface TreasuryBreak {
  code: string;
  severity: 'error' | 'warning';
  detail: string;
  asset?: string;
  references: string[];
}

export interface TreasuryReport {
  generatedAt: string;
  asOf: string;
  network: string;
  treasuryAccount: string;
  freshness: Freshness;
  updateCadence: {
    hours: number;
    lastPublishedAt: string;
    nextExpectedAt: string;
  };
  status: 'reconciled' | 'unreconciled';
  reconciliation: {
    assets: TreasuryAssetReconciliation[];
    totals: {
      assets: number;
      entries: number;
      reconciledAssets: number;
      unreconciledAssets: number;
    };
  };
  policyAllocation: {
    version: string;
    approvedAt: string;
    approvedBy: string;
    reference: string;
    measuredOn: 'period_outflows';
    targetsSumBps: number;
    targetsValid: boolean;
    toleranceBps: number;
    byAsset: TreasuryPolicyAllocationByAsset[];
  };
  provenance: {
    entries: number;
    entriesWithSource: number;
    missingSourceEntryIds: string[];
    complete: boolean;
  };
  ledger: TreasuryLedgerRow[];
  breaks: TreasuryBreak[];
  warnings: TreasuryBreak[];
}

export function formatMinorUnits(minor: string, decimals: number): string {
  if (decimals === 0) return minor;
  const padded = minor.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  return `${whole}.${fraction}`;
}

const amountView = (minor: bigint, decimals: number): TreasuryAmountView => {
  const value = minor.toString();
  return { minor: value, display: formatMinorUnits(value, decimals) };
};

const shareBps = (part: bigint, whole: bigint): number =>
  whole > 0n ? Number((part * 10_000n) / whole) : 0;

/**
 * Build the public treasury view. Balance reconciliation is exact: integer
 * minor units only, no floating point, no FX conversion between assets.
 */
export function computeTreasuryReport(
  snapshot: TreasurySnapshot,
  options: { now?: Date } = {},
): TreasuryReport {
  const now = options.now ?? new Date();
  const freshness = describeFreshness(snapshot.asOf, snapshot.updateCadenceHours, now);

  const breaks: TreasuryBreak[] = [];
  const warnings: TreasuryBreak[] = [];
  const asOfMs = Date.parse(snapshot.asOf);

  const seenEntryIds = new Set<string>();
  const entries: TreasuryEntry[] = [];
  for (const entry of snapshot.entries) {
    if (seenEntryIds.has(entry.id)) {
      breaks.push({
        code: 'duplicate_entry_id',
        severity: 'error',
        detail: `Entry ${entry.id} appears more than once and was counted once`,
        asset: entry.asset,
        references: [entry.id],
      });
      continue;
    }
    seenEntryIds.add(entry.id);
    entries.push(entry);
    if (Date.parse(entry.timestamp) > asOfMs) {
      warnings.push({
        code: 'entry_after_as_of',
        severity: 'warning',
        detail: `Entry ${entry.id} is timestamped after the snapshot asOf time`,
        asset: entry.asset,
        references: [entry.id],
      });
    }
  }

  const positions = new Map(snapshot.assets.map((position) => [position.asset, position]));
  const unknownAssets = new Set<string>();
  for (const entry of entries) {
    if (!positions.has(entry.asset)) unknownAssets.add(entry.asset);
  }
  for (const asset of unknownAssets) {
    warnings.push({
      code: 'unknown_asset',
      severity: 'warning',
      detail: `Entries reference ${asset}, which has no declared balance position and is excluded from reconciliation`,
      asset,
      references: entries.filter((entry) => entry.asset === asset).map((entry) => entry.id),
    });
  }

  const assets: TreasuryAssetReconciliation[] = snapshot.assets.map((position) => {
    const scoped = entries.filter((entry) => entry.asset === position.asset);
    const inflows = scoped
      .filter((entry) => entry.direction === 'inflow')
      .reduce((acc, entry) => acc + BigInt(entry.amount), 0n);
    const outflows = scoped
      .filter((entry) => entry.direction === 'outflow')
      .reduce((acc, entry) => acc + BigInt(entry.amount), 0n);
    const opening = BigInt(position.openingBalance);
    const closing = BigInt(position.closingBalance);
    const expectedClosing = opening + inflows - outflows;
    const delta = closing - expectedClosing;

    if (delta !== 0n) {
      breaks.push({
        code: 'balance_delta',
        severity: 'error',
        detail: `Closing balance differs from opening + inflows - outflows by ${formatMinorUnits(
          (delta < 0n ? -delta : delta).toString(),
          position.decimals,
        )} ${position.asset}${delta < 0n ? ' (closing is lower)' : ' (closing is higher)'}`,
        asset: position.asset,
        references: [position.source?.ref ?? `${position.asset}:balance`],
      });
    }
    if (position.source === undefined) {
      warnings.push({
        code: 'missing_balance_source',
        severity: 'warning',
        detail: `Declared opening/closing balances for ${position.asset} have no ledger source reference`,
        asset: position.asset,
        references: [],
      });
    }

    return {
      asset: position.asset,
      decimals: position.decimals,
      openingBalance: amountView(opening, position.decimals),
      inflows: amountView(inflows, position.decimals),
      outflows: amountView(outflows, position.decimals),
      expectedClosing: amountView(expectedClosing, position.decimals),
      closingBalance: amountView(closing, position.decimals),
      delta: amountView(delta, position.decimals),
      reconciled: delta === 0n,
      entryCount: scoped.length,
      inflowCount: scoped.filter((entry) => entry.direction === 'inflow').length,
      outflowCount: scoped.filter((entry) => entry.direction === 'outflow').length,
    };
  });

  const missingSourceEntryIds = entries
    .filter((entry) => entry.source === undefined)
    .map((entry) => entry.id);
  if (missingSourceEntryIds.length > 0) {
    breaks.push({
      code: 'missing_source_reference',
      severity: 'error',
      detail: `${missingSourceEntryIds.length} treasury entries have no ledger/transaction source reference`,
      references: missingSourceEntryIds,
    });
  }

  const targetsSumBps = snapshot.policy.allocations.reduce(
    (acc, allocation) => acc + allocation.targetShareBps,
    0,
  );
  const targetsValid = targetsSumBps === 10_000;
  if (!targetsValid) {
    warnings.push({
      code: 'policy_targets_incomplete',
      severity: 'warning',
      detail: `Policy allocations sum to ${targetsSumBps} bps instead of 10000 bps`,
      references: [snapshot.policy.version],
    });
  }

  const targetByPolicy = new Map(
    snapshot.policy.allocations.map((allocation) => [allocation.policy, allocation]),
  );
  for (const entry of entries) {
    if (!targetByPolicy.has(entry.policy)) {
      warnings.push({
        code: 'unmapped_policy',
        severity: 'warning',
        detail: `Entry ${entry.id} uses policy "${entry.policy}" with no allocation target`,
        asset: entry.asset,
        references: [entry.id],
      });
    }
  }

  const byAsset: TreasuryPolicyAllocationByAsset[] = snapshot.assets.map((position) => {
    const scopedOutflows = entries.filter(
      (entry) => entry.asset === position.asset && entry.direction === 'outflow',
    );
    const totalOutflow = scopedOutflows.reduce((acc, entry) => acc + BigInt(entry.amount), 0n);
    const outflowByPolicy = new Map<string, bigint>();
    for (const entry of scopedOutflows) {
      outflowByPolicy.set(
        entry.policy,
        (outflowByPolicy.get(entry.policy) ?? 0n) + BigInt(entry.amount),
      );
    }

    const allocations: TreasuryPolicyAllocation[] = snapshot.policy.allocations.map(
      (allocation) => {
        const outflow = outflowByPolicy.get(allocation.policy) ?? 0n;
        const actualShareBps = shareBps(outflow, totalOutflow);
        const deviationBps = actualShareBps - allocation.targetShareBps;
        const withinTolerance = Math.abs(deviationBps) <= TREASURY_POLICY_TOLERANCE_BPS;
        if (totalOutflow > 0n && !withinTolerance) {
          warnings.push({
            code: 'policy_allocation_drift',
            severity: 'warning',
            detail: `${allocation.policy} spend in ${position.asset} is ${actualShareBps} bps vs ${allocation.targetShareBps} bps target (tolerance ${TREASURY_POLICY_TOLERANCE_BPS} bps)`,
            asset: position.asset,
            references: [snapshot.policy.version],
          });
        }
        return {
          policy: allocation.policy,
          targetShareBps: allocation.targetShareBps,
          actualShareBps,
          deviationBps,
          outflow: amountView(outflow, position.decimals),
          withinTolerance,
        };
      },
    );

    return {
      asset: position.asset,
      totalOutflow: amountView(totalOutflow, position.decimals),
      allocations,
    };
  });

  if (freshness.status === 'stale') {
    warnings.push({
      code: 'snapshot_stale',
      severity: 'warning',
      detail: `Treasury snapshot is ${freshness.ageHours}h old; cadence is ${snapshot.updateCadenceHours}h`,
      references: [snapshot.asOf],
    });
  }

  const decimalsByAsset = new Map(snapshot.assets.map((position) => [position.asset, position.decimals]));
  const ledger: TreasuryLedgerRow[] = [...entries]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      direction: entry.direction,
      asset: entry.asset,
      decimals: decimalsByAsset.get(entry.asset) ?? null,
      amount:
        decimalsByAsset.has(entry.asset)
          ? amountView(BigInt(entry.amount), decimalsByAsset.get(entry.asset) as number)
          : { minor: entry.amount, display: `${entry.amount} (minor units)` },
      category: entry.category,
      policy: entry.policy,
      source: entry.source ?? null,
      counterparty: entry.counterparty ?? null,
      memo: entry.memo ?? null,
    }));

  const reconciledAssets = assets.filter((asset) => asset.reconciled).length;
  const hasErrors = breaks.some((item) => item.severity === 'error');

  return {
    generatedAt: now.toISOString(),
    asOf: snapshot.asOf,
    network: snapshot.network,
    treasuryAccount: snapshot.treasuryAccount,
    freshness,
    updateCadence: {
      hours: snapshot.updateCadenceHours,
      lastPublishedAt: snapshot.asOf,
      nextExpectedAt: freshness.nextExpectedAt,
    },
    status: hasErrors ? 'unreconciled' : 'reconciled',
    reconciliation: {
      assets,
      totals: {
        assets: assets.length,
        entries: entries.length,
        reconciledAssets,
        unreconciledAssets: assets.length - reconciledAssets,
      },
    },
    policyAllocation: {
      version: snapshot.policy.version,
      approvedAt: snapshot.policy.approvedAt,
      approvedBy: snapshot.policy.approvedBy,
      reference: snapshot.policy.reference,
      measuredOn: 'period_outflows',
      targetsSumBps,
      targetsValid,
      toleranceBps: TREASURY_POLICY_TOLERANCE_BPS,
      byAsset,
    },
    provenance: {
      entries: entries.length,
      entriesWithSource: entries.length - missingSourceEntryIds.length,
      missingSourceEntryIds,
      complete: missingSourceEntryIds.length === 0,
    },
    ledger,
    breaks,
    warnings,
  };
}
