import { describe, it, expect } from 'vitest';
import {
  computeTreasuryReport,
  formatMinorUnits,
} from '../../src/governance/transparency/treasury';
import type { TreasurySnapshot } from '../../src/governance/transparency/schema';

const NOW = new Date('2026-10-20T12:00:00.000Z');

function baselineSnapshot(): TreasurySnapshot {
  return {
    asOf: '2026-10-20T00:00:00.000Z',
    network: 'testnet',
    treasuryAccount: 'GTREASURYACCOUNT000000000000000000000000000000000000',
    updateCadenceHours: 24,
    assets: [
      {
        asset: 'XLM',
        decimals: 7,
        openingBalance: '1000000000',
        closingBalance: '1200000000',
        source: { kind: 'account', ref: 'GTREASURYACCOUNT000000000000000000000000000000000000' },
      },
    ],
    policy: {
      version: '2026-Q4',
      approvedAt: '2026-10-01T00:00:00.000Z',
      approvedBy: 'Treasury Committee (multisig 3-of-5)',
      reference: 'https://github.com/Stellar-Unified-Price-Oracle/docs/treasury-policy',
      allocations: [
        { policy: 'operations', targetShareBps: 3333 },
        { policy: 'security', targetShareBps: 6667 },
      ],
    },
    entries: [
      {
        id: 'in-1',
        timestamp: '2026-10-19T10:00:00.000Z',
        direction: 'inflow',
        asset: 'XLM',
        amount: '500000000',
        category: 'slash',
        policy: 'operations',
        source: { kind: 'transaction', ref: 'abc123', url: 'https://stellar.expert/tx/abc123' },
      },
      {
        id: 'out-1',
        timestamp: '2026-10-19T12:00:00.000Z',
        direction: 'outflow',
        asset: 'XLM',
        amount: '200000000',
        category: 'audit',
        policy: 'security',
        source: { kind: 'transaction', ref: 'def456', url: 'https://stellar.expert/tx/def456' },
      },
      {
        id: 'out-2',
        timestamp: '2026-10-19T14:00:00.000Z',
        direction: 'outflow',
        asset: 'XLM',
        amount: '100000000',
        category: 'infra',
        policy: 'operations',
        source: { kind: 'invoice', ref: 'invoice-77' },
      },
    ],
  };
}

describe('treasury transparency (#781)', () => {
  it('reconciles opening + inflows - outflows against the published closing balance', () => {
    const report = computeTreasuryReport(baselineSnapshot(), { now: NOW });

    expect(report.status).toBe('reconciled');
    expect(report.reconciliation.totals).toEqual({
      assets: 1,
      entries: 3,
      reconciledAssets: 1,
      unreconciledAssets: 0,
    });

    const asset = report.reconciliation.assets[0];
    expect(asset.openingBalance.minor).toBe('1000000000');
    expect(asset.inflows.minor).toBe('500000000');
    expect(asset.outflows.minor).toBe('300000000');
    expect(asset.expectedClosing.minor).toBe('1200000000');
    expect(asset.closingBalance.display).toBe('120.0000000');
    expect(asset.delta.minor).toBe('0');
    expect(asset.reconciled).toBe(true);

    expect(report.provenance.complete).toBe(true);
    expect(report.provenance.entriesWithSource).toBe(3);
    expect(report.freshness.status).toBe('fresh');
    expect(report.breaks).toEqual([]);
  });

  it('surfaces a balance delta as an error break and marks the report unreconciled', () => {
    const snapshot = baselineSnapshot();
    snapshot.assets[0].closingBalance = '1250000000';

    const report = computeTreasuryReport(snapshot, { now: NOW });

    expect(report.status).toBe('unreconciled');
    expect(report.breaks).toContainEqual(
      expect.objectContaining({ code: 'balance_delta', severity: 'error', asset: 'XLM' }),
    );
    expect(report.reconciliation.assets[0].delta.display).toBe('5.0000000');
  });

  it('flags entries without a ledger source reference', () => {
    const snapshot = baselineSnapshot();
    delete snapshot.entries[0].source;

    const report = computeTreasuryReport(snapshot, { now: NOW });

    expect(report.status).toBe('unreconciled');
    expect(report.provenance.complete).toBe(false);
    expect(report.provenance.missingSourceEntryIds).toEqual(['in-1']);
    expect(report.breaks).toContainEqual(
      expect.objectContaining({ code: 'missing_source_reference', severity: 'error' }),
    );
  });

  it('counts a duplicate entry id once and reports the duplication', () => {
    const snapshot = baselineSnapshot();
    snapshot.entries.push({ ...snapshot.entries[1] });

    const report = computeTreasuryReport(snapshot, { now: NOW });

    expect(report.provenance.entries).toBe(3);
    expect(report.breaks).toContainEqual(
      expect.objectContaining({ code: 'duplicate_entry_id', severity: 'error' }),
    );
  });

  it('reports policy allocation drift beyond the tolerance as a warning', () => {
    const snapshot = baselineSnapshot();
    snapshot.policy.allocations = [
      { policy: 'operations', targetShareBps: 9000 },
      { policy: 'security', targetShareBps: 1000 },
    ];

    const report = computeTreasuryReport(snapshot, { now: NOW });

    const xlm = report.policyAllocation.byAsset[0];
    expect(xlm.totalOutflow.minor).toBe('300000000');
    expect(xlm.allocations[0].actualShareBps).toBe(3333);
    expect(xlm.allocations[0].deviationBps).toBe(-5667);
    expect(xlm.allocations[0].withinTolerance).toBe(false);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'policy_allocation_drift', severity: 'warning' }),
    );
  });

  it('warns when policy targets do not sum to 10000 bps', () => {
    const snapshot = baselineSnapshot();
    snapshot.policy.allocations = [{ policy: 'operations', targetShareBps: 9000 }];

    const report = computeTreasuryReport(snapshot, { now: NOW });

    expect(report.policyAllocation.targetsSumBps).toBe(9000);
    expect(report.policyAllocation.targetsValid).toBe(false);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'policy_targets_incomplete' }),
    );
  });

  it('excludes entries for undeclared assets from reconciliation and warns', () => {
    const snapshot = baselineSnapshot();
    snapshot.entries.push({
      id: 'usdc-1',
      timestamp: '2026-10-19T15:00:00.000Z',
      direction: 'inflow',
      asset: 'USDC',
      amount: '10000000',
      category: 'grant',
      policy: 'operations',
      source: { kind: 'transaction', ref: 'usdc-tx' },
    });

    const report = computeTreasuryReport(snapshot, { now: NOW });

    expect(report.reconciliation.assets).toHaveLength(1);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'unknown_asset', asset: 'USDC' }),
    );
    const unknownRow = report.ledger.find((row) => row.asset === 'USDC');
    expect(unknownRow?.decimals).toBeNull();
    expect(unknownRow?.amount.display).toContain('minor units');
    expect(report.status).toBe('reconciled');
  });

  it('marks a snapshot stale after 1.5x the declared update cadence', () => {
    const report = computeTreasuryReport(baselineSnapshot(), {
      now: new Date('2026-10-21T13:00:00.000Z'),
    });

    expect(report.freshness.status).toBe('stale');
    expect(report.freshness.staleAfterHours).toBe(36);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'snapshot_stale' }));
  });

  it('formats minor units without floating point rounding', () => {
    expect(formatMinorUnits('123456789', 7)).toBe('12.3456789');
    expect(formatMinorUnits('1', 7)).toBe('0.0000001');
    expect(formatMinorUnits('42', 0)).toBe('42');
  });
});
