#!/usr/bin/env node
/**
 * Comprehensive diagnostic tool for history gap issues.
 * 
 * Checks:
 * - Database connectivity
 * - Available history data files
 * - Current gap status
 * - Backfill readiness
 * - GitHub issue status
 * 
 * Usage:
 *   node scripts/diagnose-history-gaps.mjs [--fix-asset <ASSET>] [--verbose]
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Load environment
const envPath = path.resolve(repoRoot, 'api', '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const fixAsset = args.includes('--fix-asset') ? args[args.indexOf('--fix-asset') + 1] : null;

function log(msg, prefix = 'ℹ️ ') {
  console.log(`${prefix}${msg}`);
}

function success(msg) {
  console.log(`✅ ${msg}`);
}

function warn(msg) {
  console.log(`⚠️  ${msg}`);
}

function error(msg) {
  console.log(`❌ ${msg}`);
}

async function runCommand(cmd, args, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: verbose ? 'inherit' : 'pipe',
    });
    
    let stdout = '';
    let stderr = '';
    
    if (!verbose) {
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }
    
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function checkDatabaseConnection() {
  log('Checking database connectivity...', '🔌 ');
  
  const dbUrl = process.env.DATABASE_URL || process.env.HISTORY_DATABASE_URL;
  
  if (!dbUrl) {
    warn('DATABASE_URL or HISTORY_DATABASE_URL not set');
    return false;
  }
  
  if (verbose) {
    log(`Using: ${dbUrl.replace(/:[^@]*@/, ':***@')}`);
  }
  
  // Simple connection test via psql
  const result = await runCommand('psql', [
    dbUrl,
    '-c',
    'SELECT 1;',
  ]);
  
  if (result.code === 0) {
    success('Database connection OK');
    return true;
  }
  
  error('Database connection failed');
  if (verbose) {
    console.error(result.stderr);
  }
  return false;
}

function checkHistoryFiles() {
  log('Checking for history data files...', '📁 ');
  
  const searchDirs = [
    path.resolve(repoRoot, 'data'),
    path.resolve(repoRoot, 'api', 'data'),
    path.resolve(repoRoot, 'services', 'aggregator', 'data'),
  ];
  
  let foundAny = false;
  const files = new Map();
  
  for (const dir of searchDirs) {
    if (existsSync(dir)) {
      const entries = readdirSync(dir).filter(f => /^history-.+\.json$/i.test(f));
      if (entries.length > 0) {
        foundAny = true;
        for (const file of entries) {
          const asset = file.replace(/^history-/i, '').replace(/\.json$/i, '').toUpperCase();
          files.set(asset, path.join(dir, file));
        }
        if (verbose) {
          log(`Found ${entries.length} file(s) in ${dir}`, '  ');
        }
      }
    }
  }
  
  if (foundAny) {
    success(`Found ${files.size} history data file(s)`);
    if (verbose) {
      for (const [asset, filePath] of files) {
        const stats = require('fs').statSync(filePath);
        log(`${asset}: ${(stats.size / 1024).toFixed(1)} KB`, '  ');
      }
    }
    return files;
  }
  
  error('No history-*.json files found');
  return new Map();
}

async function checkCurrentGaps() {
  log('Scanning for current gaps...', '🔍 ');
  
  const apiDir = path.resolve(repoRoot, 'api');
  const result = await runCommand('npm', ['run', '--silent', 'history:gaps', '--', '--json'], apiDir);
  
  if (result.code !== 0 && result.code !== 1) {
    error('Gap detection failed');
    if (verbose) {
      console.error(result.stderr);
    }
    return null;
  }
  
  try {
    const report = JSON.parse(result.stdout);
    const alerting = (report.gaps || []).filter(g => g.gapSeconds > (report.alertThreshold || 900));
    
    if (alerting.length === 0) {
      success('No gaps exceeding alert threshold');
      return report;
    }
    
    warn(`Found ${alerting.length} alerting gap(s)`);
    if (verbose) {
      for (const gap of alerting) {
        log(`${gap.asset}: ${gap.gapSeconds}s (${gap.missingSnapshots} missing snapshots)`, '  ');
      }
    }
    
    return report;
  } catch (e) {
    error('Could not parse gap report');
    if (verbose) {
      console.error('Output was:', result.stdout);
    }
    return null;
  }
}

async function checkGitHubIssues() {
  log('Checking for open gap alerts...', '📍 ');
  
  const result = await runCommand('gh', [
    'issue',
    'list',
    '--label',
    'data,alert',
    '--state',
    'open',
    '--search',
    'price_history gap detected',
    '--json',
    'number,title,createdAt',
  ]);
  
  if (result.code !== 0) {
    log('GitHub CLI not configured (install: gh auth login)', '  ');
    return [];
  }
  
  try {
    const issues = JSON.parse(result.stdout);
    if (issues.length > 0) {
      warn(`Found ${issues.length} open gap alert issue(s)`);
      if (verbose) {
        for (const issue of issues) {
          log(`#${issue.number}: ${issue.title}`, '  ');
        }
      }
    } else {
      success('No open gap alert issues');
    }
    return issues;
  } catch (e) {
    if (verbose) {
      log('Could not parse GitHub issues', '  ');
    }
    return [];
  }
}

async function runDiagnostics() {
  console.log('\n🔧 History Gap Diagnostics\n');
  console.log('='.repeat(50));
  console.log('');
  
  const dbOk = await checkDatabaseConnection();
  console.log('');
  
  const historyFiles = checkHistoryFiles();
  console.log('');
  
  const gaps = await checkCurrentGaps();
  console.log('');
  
  const issues = await checkGitHubIssues();
  console.log('');
  
  // Summary
  console.log('='.repeat(50));
  console.log('');
  console.log('📊 Summary:');
  console.log('');
  
  if (!dbOk) {
    error('Cannot proceed: database not accessible');
    process.exit(1);
  }
  
  if (gaps && gaps.gaps && gaps.gaps.length > 0) {
    const alerting = gaps.gaps.filter(g => g.gapSeconds > (gaps.alertThreshold || 900));
    if (alerting.length > 0) {
      warn(`${alerting.length} gap(s) need backfilling`);
      console.log('');
      console.log('Recommended next steps:');
      console.log('');
      for (const gap of alerting) {
        console.log(`  npm run history:backfill -- --asset ${gap.asset} --from ${gap.startTs} --to ${gap.endTs}`);
      }
      console.log('');
    }
  } else {
    success('History looks clean!');
  }
  
  if (fixAsset) {
    console.log('');
    console.log('🔧 Executing backfill for', fixAsset);
    console.log('');
    const apiDir = path.resolve(repoRoot, 'api');
    const backfillResult = await runCommand('npm', ['run', 'history:backfill', '--', '--asset', fixAsset], apiDir);
    process.exit(backfillResult.code);
  }
}

runDiagnostics().catch((err) => {
  error(err.message);
  process.exit(1);
});
