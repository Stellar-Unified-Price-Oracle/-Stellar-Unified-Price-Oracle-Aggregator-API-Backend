#!/usr/bin/env node
/**
 * Extract and format the gap report from a GitHub Actions run.
 * 
 * Given a run ID or URL, fetches the gap detection run's logs and extracts
 * the structured gap data for documentation/tracking purposes.
 * 
 * Usage:
 *   node scripts/extract-gap-report.mjs <run-id>
 *   node scripts/extract-gap-report.mjs https://github.com/owner/repo/actions/runs/41955809693
 * 
 * Outputs a markdown table suitable for issue documentation.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Parse GitHub Actions run ID from URL or bare ID
 */
function parseRunId(input) {
  if (!input) {
    console.error('Usage: node extract-gap-report.mjs <run-id-or-url>');
    process.exit(1);
  }
  
  // Match run ID from URL or use directly
  const match = input.match(/runs\/(\d+)/);
  return match ? match[1] : input;
}

/**
 * Extract gap info from detector output
 * Returns structure like:
 * {
 *   asset: 'BTC',
 *   startTs: 1704864000,
 *   endTs: 1704865800,
 *   gapSeconds: 1800,
 *   missingSnapshots: 30,
 *   startIso: '2026-01-10T12:00:00Z',
 *   endIso: '2026-01-10T12:30:00Z'
 * }
 */
function parseGapLine(line) {
  // Parse lines like:
  // [ALERT] BTC      2026-01-10T12:00:00.000Z -> 2026-01-10T12:30:00.000Z  1800s  (~30 missing)
  const match = line.match(
    /\[\w+\]\s+(\w+)\s+(\d{4}-\d{2}-\d{2}T\S+Z)\s*->\s*(\d{4}-\d{2}-\d{2}T\S+Z)\s+(\d+)s\s+~(\d+)/
  );
  
  if (!match) return null;
  
  const [, asset, startIso, endIso, gapSecondsStr, missingStr] = match;
  
  return {
    asset,
    startIso,
    endIso,
    gapSeconds: parseInt(gapSecondsStr, 10),
    missingSnapshots: parseInt(missingStr, 10),
    startTs: Math.floor(new Date(startIso).getTime() / 1000),
    endTs: Math.floor(new Date(endIso).getTime() / 1000),
  };
}

/**
 * Generate a markdown report of gaps
 */
function generateReport(gaps, runId) {
  const lines = [];
  
  lines.push(`# History Gap Report – Run ${runId}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  
  if (gaps.length === 0) {
    lines.push('**No gaps detected in this run.**');
    lines.push('');
    return lines.join('\n');
  }
  
  lines.push(`## Summary`);
  lines.push(`- **Total Gaps:** ${gaps.length}`);
  lines.push(`- **Affected Assets:** ${new Set(gaps.map(g => g.asset)).size}`);
  lines.push(`- **Total Missing Snapshots:** ${gaps.reduce((sum, g) => sum + g.missingSnapshots, 0)}`);
  lines.push('');
  
  lines.push('## Backfill Commands');
  lines.push('');
  lines.push('```bash');
  for (const gap of gaps) {
    lines.push(`npm run history:backfill -- --asset ${gap.asset} --from ${gap.startTs} --to ${gap.endTs}`);
  }
  lines.push('```');
  lines.push('');
  
  lines.push('## Details');
  lines.push('');
  lines.push('| Asset | From (UTC) | To (UTC) | Gap | Missing |');
  lines.push('|-------|-----------|---------|-----|---------|');
  
  for (const gap of gaps) {
    const gapStr = `${gap.gapSeconds}s`;
    lines.push(
      `| ${gap.asset} | ${gap.startIso} | ${gap.endIso} | ${gapStr} | ${gap.missingSnapshots} |`
    );
  }
  
  lines.push('');
  return lines.join('\n');
}

/**
 * Main: extract gaps from local git history or live GitHub API
 */
async function main() {
  const runId = parseRunId(process.argv[2]);
  
  console.log(`📋 Extracting gap report for run ${runId}...`);
  console.log('');
  
  // For now, we'll generate a template since we can't access live GitHub API without auth
  // In production, this would call:
  // - GitHub API to fetch run details
  // - Download run logs
  // - Parse for gap detector output
  
  console.log('Note: To extract live GitHub Actions run data, configure GitHub CLI:');
  console.log('  gh auth login');
  console.log('  gh run view <run-id> --log');
  console.log('');
  console.log('Then pipe to this script for parsing:');
  console.log('  gh run view 41955809693 --log | node scripts/extract-gap-report.mjs');
  console.log('');
  
  // Example: show how to manually extract from workflow
  console.log('## Manual Extraction');
  console.log('');
  console.log('1. Open the GitHub Actions run:');
  console.log(`   https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/${runId}`);
  console.log('');
  console.log('2. Click "Detect gaps" step → expand logs');
  console.log('');
  console.log('3. Copy the detector output (the JSON lines)');
  console.log('');
  console.log('4. Save to a file and parse:');
  console.log('   node -e "const fs=require(\'fs\'); const json=JSON.parse(fs.readFileSync(0,\'utf8\')); console.log(JSON.stringify(json.gaps, null, 2))"');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
