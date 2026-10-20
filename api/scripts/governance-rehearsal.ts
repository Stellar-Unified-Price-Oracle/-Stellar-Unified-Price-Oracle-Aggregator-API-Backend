#!/usr/bin/env tsx
/**
 * Run the governance lifecycle rehearsal (issue #780).
 *
 * The runner executes every governance path against an in-memory model of the
 * GovernanceContract — proposal creation, voting, quorum/majority resolution,
 * queue, execute, cancel, guardian emergency execution, and the rejection
 * paths — and produces the published report and Markdown summary.
 *
 * The model mirrors contracts/price-oracle/src/governance.rs, including the
 * rollback-on-error behaviour that leaves a defeated proposal `Active` in
 * storage and resolves it on read.
 *
 * Usage:
 *   tsx api/scripts/governance-rehearsal.ts [--json] [--write] [--md <path>] [--now <iso>]
 *
 *   --write      persist rehearsal-report.json into GOVERNANCE_TRANSPARENCY_DIR
 *   --md <path>  write the Markdown report to a file as well as stdout
 *
 * The public testnet run uses the same scenario matrix with a funded testnet
 * identity; see docs/governance/TESTNET_REHEARSAL.md. This runner never labels
 * a simulation as a network run.
 *
 * Exit codes:
 *   0  every scenario passed
 *   1  at least one scenario failed
 *   2  usage error
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { renderRehearsalMarkdown, runGovernanceRehearsal } from '../src/governance/transparency/rehearsal';
import { writeArtifact } from '../src/governance/transparency/store';

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const asJson = args.includes('--json');
const shouldWrite = args.includes('--write');
const markdownPath = flag('md');
const network = flag('network') ?? 'local-simulation';
const contractId = flag('contract-id') ?? null;
const nowArg = flag('now');
const now = nowArg ? new Date(nowArg) : new Date();

if (Number.isNaN(now.getTime())) {
  console.error(`Invalid --now value: ${nowArg}`);
  process.exit(2);
}

if (network !== 'local-simulation') {
  console.error(
    `This runner only executes the local simulation. To rehearse on ${network}, follow\n` +
      'docs/governance/TESTNET_REHEARSAL.md and attach the transaction hashes to the report.',
  );
  process.exit(2);
}

if (contractId) {
  console.error('--contract-id is only meaningful for an on-chain run; the local simulation has no contract.');
  process.exit(2);
}

const report = runGovernanceRehearsal({ network, contractId, now });
const markdown = renderRehearsalMarkdown(report);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(markdown);
}

if (markdownPath) {
  const resolved = path.resolve(markdownPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, markdown, 'utf-8');
  console.error(`Markdown report written to ${resolved}`);
}

if (shouldWrite) {
  const written = writeArtifact('rehearsal-report.json', report);
  console.error(`Rehearsal report published to ${written}`);
}

process.exit(report.summary.verdict === 'passed' ? 0 : 1);
