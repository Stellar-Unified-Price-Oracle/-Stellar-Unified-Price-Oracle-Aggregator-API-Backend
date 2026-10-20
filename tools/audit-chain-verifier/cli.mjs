#!/usr/bin/env node
import fs from 'node:fs';
import { parseLog, verifyChain, exportAnchors } from './verify.mjs';

const USAGE = `Usage: audit-chain-verifier <log.jsonl> --keys <keys.json> [--anchors <anchors.json>] [--export-anchors]
  keys.json     JSON array of plaintext signing secrets (oldest first, current last)
  anchors.json  JSON array of {writerId?, seq?, hmac} heads recorded outside the service
Exit codes: 0 valid, 1 invalid, 2 usage or input error`;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

try {
  const logPath = args.find((a) => !a.startsWith('--') && a !== opt('--keys') && a !== opt('--anchors'));
  const keysPath = opt('--keys');
  if (!logPath || !keysPath) {
    console.error(USAGE);
    process.exit(2);
  }
  const secrets = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  const anchors = opt('--anchors') ? JSON.parse(fs.readFileSync(opt('--anchors'), 'utf8')) : [];
  if (!Array.isArray(secrets) || !secrets.every((s) => typeof s === 'string')) throw new Error('keys file must be a JSON array of strings');

  const { entries, malformed } = parseLog(fs.readFileSync(logPath, 'utf8'));
  const result = verifyChain(entries, { secrets, anchors });
  if (malformed.length) {
    result.valid = false;
    for (const line of malformed) result.findings.push({ index: -1, code: 'malformed-line', message: `line ${line} is not valid JSON` });
  }
  if (args.includes('--export-anchors')) result.anchors = exportAnchors(entries);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(2);
}
