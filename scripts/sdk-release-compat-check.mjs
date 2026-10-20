#!/usr/bin/env node
// Gate an SDK release on API/contract compatibility and generate release notes.
// No dependencies. Usage:
//   node scripts/sdk-release-compat-check.mjs --tag=sdk-v1.2.3 [--sdk-dir=sdk] [--out=sdk-release-notes.md]
// Compatibility policy file (optional): sdk/compat.json
//   { "supportedServer": [">=2.0.0 <3.0.0"], "schemaVersions": ["v2"], "contractAbi": ["1"] }
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || d;
const tag = arg('tag', process.env.GITHUB_REF_NAME || '');
const sdkDir = arg('sdk-dir', 'sdk');
const out = arg('out', 'sdk-release-notes.md');
const errors = [];

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const semver = (v) => /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.test(v || '');
const major = (v) => Number(String(v).split('.')[0]);

// 1. Tag must be sdk-vX.Y.Z and match the SDK package version.
const tagVersion = tag.replace(/^sdk-v/, '');
if (!tag.startsWith('sdk-v') || !semver(tagVersion)) errors.push(`tag "${tag}" must look like sdk-vX.Y.Z`);
const pkg = readJson(join(sdkDir, 'package.json'));
if (!pkg) errors.push(`${join(sdkDir, 'package.json')} not found`);
else if (pkg.version !== tagVersion) errors.push(`package version ${pkg.version} does not match tag ${tagVersion}`);

// 2. Server and contract versions from the repository.
const apiPkg = readJson('api/package.json');
const serverVersion = apiPkg?.version;
if (!semver(serverVersion)) errors.push('api/package.json has no valid semver version');
const cargo = existsSync('contracts/price-oracle/Cargo.toml') ? readFileSync('contracts/price-oracle/Cargo.toml', 'utf8') : '';
const contractVersion = (cargo.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
if (!contractVersion) errors.push('contracts/price-oracle/Cargo.toml has no version');

// 3. Compatibility policy: server major must be within the supported ranges.
const compat = readJson(join(sdkDir, 'compat.json')) || { supportedServer: [], schemaVersions: [], contractAbi: [] };
const rangeMajors = (compat.supportedServer || []).flatMap((r) => [...r.matchAll(/(\d+)\.\d+\.\d+/g)].map((m) => Number(m[1])));
if (!compat.supportedServer?.length) errors.push(`${join(sdkDir, 'compat.json')} must declare supportedServer ranges`);
else if (serverVersion && !rangeMajors.includes(major(serverVersion)) && !rangeMajors.some((m) => m < major(serverVersion))) {
  errors.push(`server ${serverVersion} is outside supportedServer ${JSON.stringify(compat.supportedServer)}`);
}
if (!compat.schemaVersions?.length) errors.push('compat.json must declare schemaVersions');
if (!compat.contractAbi?.length) errors.push('compat.json must declare contractAbi');
else if (contractVersion && !compat.contractAbi.includes(String(major(contractVersion)))) {
  errors.push(`contract ${contractVersion} (ABI major ${major(contractVersion)}) not in contractAbi ${JSON.stringify(compat.contractAbi)}`);
}

if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error('SDK release blocked: compatibility gate failed.');
  process.exit(1);
}

const notes = `# SDK ${tagVersion}

## Compatibility
| Component | Supported |
| --- | --- |
| Aggregator API server | ${compat.supportedServer.join(', ')} (repository at ${serverVersion}) |
| API/schema versions | ${compat.schemaVersions.join(', ')} |
| Price oracle contract ABI | major ${compat.contractAbi.join(', ')} (repository at ${contractVersion}) |

Compatibility was verified by \`scripts/sdk-release-compat-check.mjs\` and the repository API and contract test jobs before this release.
`;
writeFileSync(out, notes);
console.log(`compatibility gate passed; release notes written to ${out}`);
