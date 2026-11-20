#!/usr/bin/env node
/**
 * Fix history gaps discovered by the gap detection workflow.
 * 
 * This script:
 * 1. Detects current gaps in price_history
 * 2. Provides backfill commands for each gap
 * 3. Optionally executes backfill for specified assets
 * 
 * Usage:
 *   node scripts/fix-history-gaps.mjs [--detect] [--fix <asset>] [--all]
 * 
 * Examples:
 *   node scripts/fix-history-gaps.mjs --detect          # Show current gaps
 *   node scripts/fix-history-gaps.mjs --fix BTC --from 1719378000 --to 1719378600
 *   node scripts/fix-history-gaps.mjs --fix BTC --dry-run
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

const detect = hasFlag('detect');
const fixAsset = flag('fix');
const dryRun = hasFlag('dry-run');
const all = hasFlag('all');
const from = flag('from');
const to = flag('to');

async function runCommand(cmd, cmdArgs, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, { cwd, stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0 || code === 1) {
        resolve(code);
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

async function main() {
  try {
    if (detect || (!fixAsset && !all)) {
      console.log('📊 Detecting history gaps...\n');
      const apiDir = path.resolve(__dirname, '../api');
      const exitCode = await runCommand('npm', ['run', '--silent', 'history:gaps', '--', '--json'], apiDir);
      if (exitCode === 1) {
        console.log('\n⚠️  Gaps detected. Use --fix <ASSET> to backfill.');
      } else if (exitCode === 0) {
        console.log('\n✅ No gaps detected.');
      }
      return;
    }

    if (fixAsset) {
      console.log(`🔧 Backfilling history for ${fixAsset}...\n`);
      const apiDir = path.resolve(__dirname, '../api');
      const backfillArgs = ['run', 'history:backfill', '--', '--asset', fixAsset];
      
      if (dryRun) {
        backfillArgs.push('--dry-run');
      }
      if (from) {
        backfillArgs.push('--from', from);
      }
      if (to) {
        backfillArgs.push('--to', to);
      }

      const exitCode = await runCommand('npm', backfillArgs, apiDir);
      
      if (!dryRun && exitCode === 0) {
        console.log('\n✅ Backfill complete. Re-running gap detection...\n');
        await runCommand('npm', ['run', '--silent', 'history:gaps', '--', '--json'], apiDir);
      }
      return;
    }

    if (all) {
      console.log('🔧 Backfilling all history files...\n');
      const apiDir = path.resolve(__dirname, '../api');
      const backfillArgs = ['run', 'history:backfill', '--', '--all'];
      
      if (dryRun) {
        backfillArgs.push('--dry-run');
      }

      const exitCode = await runCommand('npm', backfillArgs, apiDir);
      
      if (!dryRun && exitCode === 0) {
        console.log('\n✅ Backfill complete. Re-running gap detection...\n');
        await runCommand('npm', ['run', '--silent', 'history:gaps', '--', '--json'], apiDir);
      }
      return;
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
