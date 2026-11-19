import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLedger,
  classifyEligibility,
  computeAttainment,
  creditPctFor,
  ledgerDigest,
  mergeIntervals,
  monthWindow,
  renderCreditReport,
  runServiceCredits,
  validateIncidents,
} from '../service-credits.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function load() {
  const manifest = JSON.parse(await readFile(path.join(root, 'config', 'service-credits.json'), 'utf8'));
  const sustainability = JSON.parse(await readFile(path.join(root, 'config', 'sustainability-model.json'), 'utf8'));
  const fees = Object.fromEntries(Object.entries(sustainability.revenueTiers).map(([k, v]) => [k, v.baseFeeMonthlyUsd]));
  return { manifest, fees };
}

test('committed period reconciles and matches the document', async () => {
  const { manifest, fees } = await load();
  const result = runServiceCredits(manifest, fees);
  assert.deepEqual(result.errors, []);
  assert.equal(result.totalCreditUsd, 137);
  const byId = Object.fromEntries(result.ledger.map((l) => [l.consumerId, l]));
  assert.equal(byId['c-ent-01'].creditUsd, 125);
  assert.equal(byId['c-pro-07'].creditUsd, 12);
  assert.equal(byId['c-free-44'].eligible, false);
  assert.equal(byId['c-free-44'].creditUsd, 0);
  const existing = await readFile(path.join(root, 'docs', 'SERVICE_CREDIT_RECONCILIATION.md'), 'utf8');
  assert.equal(existing.trim(), renderCreditReport(manifest, result).trim());
});

test('overlapping incidents are merged, not double counted', async () => {
  const { manifest } = await load();
  const { attainment } = computeAttainment(manifest);
  assert.equal(attainment['us-east-1'].availability.badMinutes, 70);
  assert.deepEqual(attainment['us-east-1'].availability.incidents, ['INC-101', 'INC-102']);
  const merged = mergeIntervals([
    { start: 0, end: 10, ids: ['a'] },
    { start: 10, end: 15, ids: ['b'] },
    { start: 20, end: 30, ids: ['c'] },
    { start: 2, end: 5, ids: ['d'] },
  ]);
  assert.deepEqual(merged, [
    { start: 0, end: 15, ids: ['a', 'd', 'b'] },
    { start: 20, end: 30, ids: ['c'] },
  ]);
});

test('incidents crossing the month boundary are clipped to the period', async () => {
  const { manifest } = await load();
  const { attainment } = computeAttainment(manifest);
  assert.equal(attainment['eu-west-1'].latency.badMinutes, 60);
  assert.deepEqual(monthWindow('2026-02'), { start: Date.UTC(2026, 1, 1), end: Date.UTC(2026, 2, 1), minutes: 40320 });
  assert.throws(() => monthWindow('2026-10-01'), /YYYY-MM/);
});

test('maintenance is excluded only with sufficient notice; excluded causes earn no credit', async () => {
  const { manifest } = await load();
  const { policy } = manifest;
  assert.equal(classifyEligibility({ cause: 'scheduled-maintenance', maintenanceNoticeHours: 72 }, policy).eligible, false);
  assert.equal(classifyEligibility({ cause: 'scheduled-maintenance', maintenanceNoticeHours: 71.9 }, policy).eligible, true);
  assert.equal(classifyEligibility({ cause: 'customer-caused' }, policy).eligible, false);
  assert.equal(classifyEligibility({ cause: 'deploy-regression' }, policy).eligible, true);
  const { attainment } = computeAttainment(manifest);
  assert.equal(attainment['eu-west-1'].availability.badMinutes, 0);
  assert.equal(attainment['ap-southeast-1'].availability.badMinutes, 40);
});

test('credit schedule boundaries: exactly at objective earns nothing, just below earns the band', async () => {
  const { manifest } = await load();
  const schedule = manifest.policy.slis.availability.schedule;
  assert.equal(creditPctFor(99.9, schedule), 0);
  assert.equal(creditPctFor(99.8999, schedule), 10);
  assert.equal(creditPctFor(99.5, schedule), 10);
  assert.equal(creditPctFor(99.4, schedule), 25);
  assert.equal(creditPctFor(98, schedule), 50);
  assert.equal(creditPctFor(100, schedule), 0);
});

test('credits sum across SLIs and are capped', async () => {
  const { manifest, fees } = await load();
  const attainment = {
    'us-east-1': {
      availability: { attainmentPct: 98, incidents: ['X'] },
      freshness: { attainmentPct: 98, incidents: ['Y'] },
      latency: { attainmentPct: 100, incidents: [] },
    },
  };
  const ledger = buildLedger(
    { ...manifest, consumers: [{ id: 'c', plan: 'enterprise', region: 'us-east-1' }] },
    attainment,
    fees,
  );
  assert.equal(ledger[0].uncappedPct, 75);
  assert.equal(ledger[0].creditPct, 50);
  assert.equal(ledger[0].capped, true);
  assert.equal(ledger[0].creditUsd, 625);
  assert.throws(
    () => buildLedger({ ...manifest, consumers: [{ id: 'z', plan: 'platinum', region: 'us-east-1' }] }, attainment, fees),
    /no monthly fee/,
  );
});

test('a missing incident is caught by reconciliation against measured attainment', async () => {
  const { manifest, fees } = await load();
  const missing = structuredClone(manifest);
  missing.incidents = missing.incidents.filter((i) => i.id !== 'INC-102');
  const result = runServiceCredits(missing, fees);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /us-east-1 availability/);

  const banded = structuredClone(manifest);
  banded.policy.reconciliationTolerancePp = 1;
  banded.measuredAttainment.values['us-east-1'].availability = 99.95;
  assert.match(runServiceCredits(banded, fees).errors.join('\n'), /disagrees with measured credit/);
});

test('invalid, open and self-approved incidents are rejected', async () => {
  const { manifest } = await load();
  const bad = structuredClone(manifest);
  bad.incidents.push(
    { ...bad.incidents[0], id: 'INC-900', endedAt: undefined },
    { ...bad.incidents[0], id: 'INC-901', endedAt: '2026-10-03T14:00:00Z' },
    { ...bad.incidents[0], id: 'INC-902', approvedBy: 'oncall-primary' },
    { ...bad.incidents[0], id: 'INC-903', cause: 'gremlins', regions: ['mars-1'], sli: 'vibes' },
    { ...bad.incidents[3], id: 'INC-904', maintenanceNoticeHours: undefined },
    { ...bad.incidents[0] },
  );
  const errors = validateIncidents(bad).join('\n');
  assert.match(errors, /INC-900: still open/);
  assert.match(errors, /INC-901: endedAt must be after startedAt/);
  assert.match(errors, /INC-902: classification must be approved by a second person/);
  assert.match(errors, /INC-903: unknown SLI "vibes"/);
  assert.match(errors, /INC-903: unknown cause "gremlins"/);
  assert.match(errors, /INC-903: unknown region "mars-1"/);
  assert.match(errors, /INC-904: scheduled maintenance requires maintenanceNoticeHours/);
  assert.match(errors, /INC-101: duplicate id/);
});

test('ledger digest changes when any credit line is altered', async () => {
  const { manifest, fees } = await load();
  const { ledger, digest } = runServiceCredits(manifest, fees);
  assert.equal(ledgerDigest(structuredClone(ledger)), digest);
  const tampered = structuredClone(ledger);
  tampered[0].creditUsd += 1;
  assert.notEqual(ledgerDigest(tampered), digest);
});
