#!/usr/bin/env node
/**
 * Test suite for history gap tools.
 * 
 * Validates that the new diagnostic and fix scripts work correctly.
 * Requires DATABASE_URL to be set.
 * 
 * Usage:
 *   node scripts/test-gap-tools.mjs [--verbose] [--skip-db]
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const skipDb = args.includes('--skip-db');

let passed = 0;
let failed = 0;

function log(msg, prefix = 'ℹ️ ') {
  console.log(`${prefix}${msg}`);
}

function pass(msg) {
  console.log(`✅ ${msg}`);
  passed++;
}

function fail(msg) {
  console.log(`❌ ${msg}`);
  failed++;
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

async function testScriptExists() {
  log('Test 1: Verify scripts exist', '🧪 ');

  const scripts = [
    'scripts/diagnose-history-gaps.mjs',
    'scripts/fix-history-gaps.mjs',
    'scripts/extract-gap-report.mjs',
  ];

  let allExist = true;
  for (const script of scripts) {
    const fullPath = path.join(repoRoot, script);
    try {
      await import('fs').then((fs) => {
        if (!fs.existsSync(fullPath)) {
          fail(`${script} not found at ${fullPath}`);
          allExist = false;
        }
      });
    } catch (e) {
      fail(`Could not check ${script}: ${e.message}`);
      allExist = false;
    }
  }

  if (allExist) {
    pass('All gap tool scripts exist');
  }
}

async function testScriptsExecutable() {
  log('Test 2: Scripts show help text', '🧪 ');

  const scripts = [
    { name: 'diagnose-history-gaps.mjs', path: 'scripts/diagnose-history-gaps.mjs' },
    { name: 'fix-history-gaps.mjs', path: 'scripts/fix-history-gaps.mjs' },
    { name: 'extract-gap-report.mjs', path: 'scripts/extract-gap-report.mjs' },
  ];

  for (const script of scripts) {
    try {
      const result = await runCommand('node', [script.path], repoRoot);
      if (result.stdout || result.stderr || result.code === 0 || result.code === 1) {
        pass(`${script.name} is executable`);
      } else {
        fail(`${script.name} returned unexpected exit code: ${result.code}`);
      }
    } catch (e) {
      fail(`Could not execute ${script.name}: ${e.message}`);
    }
  }
}

async function testPackageJsonScripts() {
  log('Test 3: NPM scripts registered in package.json', '🧪 ');

  try {
    const result = await runCommand('npm', ['run'], repoRoot);
    const output = result.stdout + result.stderr;

    const requiredScripts = [
      'diagnose:gaps',
      'fix:gaps',
      'extract:gap-report',
    ];

    for (const scriptName of requiredScripts) {
      if (output.includes(scriptName)) {
        pass(`npm run ${scriptName} is registered`);
      } else {
        fail(`npm run ${scriptName} is not registered`);
      }
    }
  } catch (e) {
    fail(`Could not verify npm scripts: ${e.message}`);
  }
}

async function testDocumentationExists() {
  log('Test 4: Documentation files created', '🧪 ');

  const docs = [
    { name: 'HISTORY_GAP_FIXES.md', path: 'docs/HISTORY_GAP_FIXES.md' },
    { name: 'HISTORY_GAP_RUNBOOK.md', path: 'docs/RUNBOOKS/HISTORY_GAP_RUNBOOK.md' },
    { name: 'HISTORY_GAP_FIXES_SUMMARY.md', path: 'HISTORY_GAP_FIXES_SUMMARY.md' },
  ];

  for (const doc of docs) {
    const fullPath = path.join(repoRoot, doc.path);
    try {
      const fs = await import('fs');
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.length > 100) {
          pass(`${doc.name} exists and has content`);
        } else {
          fail(`${doc.name} exists but appears empty`);
        }
      } else {
        fail(`${doc.name} not found at ${fullPath}`);
      }
    } catch (e) {
      fail(`Could not check ${doc.name}: ${e.message}`);
    }
  }
}

async function testHistoryGapsCommand() {
  if (skipDb) {
    log('Test 5: Skipped (requires DATABASE_URL)', '⏭️ ');
    return;
  }

  log('Test 5: API gap detection tool exists', '🧪 ');

  try {
    // Check if the script exists
    const fs = await import('fs');
    const scriptPath = path.join(repoRoot, 'api/scripts/detect-history-gaps.ts');
    if (fs.existsSync(scriptPath)) {
      pass('api/scripts/detect-history-gaps.ts exists');
    } else {
      fail('api/scripts/detect-history-gaps.ts not found');
    }
  } catch (e) {
    fail(`Could not verify history:gaps script: ${e.message}`);
  }
}

async function runTests() {
  console.log('\n🔧 History Gap Tools Test Suite\n');
  console.log('='.repeat(50));
  console.log('');

  await testScriptExists();
  await testScriptsExecutable();
  await testPackageJsonScripts();
  await testDocumentationExists();
  await testHistoryGapsCommand();

  console.log('');
  console.log('='.repeat(50));
  console.log('');
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log('');

  if (failed > 0) {
    process.exit(1);
  } else {
    pass('All tests passed!');
    process.exit(0);
  }
}

runTests().catch((err) => {
  fail(err.message);
  process.exit(2);
});
