#!/usr/bin/env node
// Fails if docs/security/audit-findings.md has a Critical-severity row that
// isn't marked Resolved. See docs/security/audit-findings.md for the process.

const fs = require('fs');
const path = require('path');

const FINDINGS_FILE = path.join(__dirname, '..', 'docs', 'security', 'audit-findings.md');

const content = fs.readFileSync(FINDINGS_FILE, 'utf8');
const rows = content
  .split('\n')
  .filter((line) => line.trim().startsWith('|'))
  .map((line) => line.split('|').map((cell) => cell.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1));

// Drop the header row and the separator row (e.g. "---|---|...").
const dataRows = rows.slice(2).filter((cells) => cells.length >= 4 && !/^-+$/.test(cells[0]));

const openCritical = dataRows.filter((cells) => {
  const [, severity, , status] = cells;
  return severity?.toLowerCase() === 'critical' && status?.toLowerCase() !== 'resolved';
});

if (openCritical.length > 0) {
  console.error(`Found ${openCritical.length} open Critical audit finding(s) in ${FINDINGS_FILE}:`);
  openCritical.forEach((cells) => console.error(`  - ${cells[0]}: ${cells[2]} (status: ${cells[3]})`));
  process.exit(1);
}

console.log('No open Critical audit findings.');
