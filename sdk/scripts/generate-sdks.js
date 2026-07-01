#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sdkRoot = path.resolve(__dirname, '..');
const specPath = path.resolve(sdkRoot, '../api/openapi.json');
const generatedRoot = path.join(sdkRoot, 'generated');

if (!fs.existsSync(specPath)) {
  console.error(`OpenAPI spec not found at ${specPath}`);
  process.exit(1);
}

const generators = [
  {
    name: 'typescript',
    generator: 'typescript-fetch',
    output: path.join(generatedRoot, 'typescript'),
    additionalProperties: [
      'npmName=@stellar-oracle/sdk-typescript',
      'npmVersion=1.0.0',
      'typescriptThreePlus=true',
    ],
  },
  {
    name: 'python',
    generator: 'python',
    output: path.join(generatedRoot, 'python'),
    additionalProperties: [
      'packageName=stellar-oracle-client',
      'packageVersion=1.0.0',
      'pythonPackageName=stellar_oracle_client',
      'generateSourceCodeOnly=true',
    ],
  },
  {
    name: 'rust',
    generator: 'rust',
    output: path.join(generatedRoot, 'rust'),
    additionalProperties: [
      'packageName=stellar-oracle-client',
      'packageVersion=1.0.0',
      'packageAuthors=Stellar-Unified-Price-Oracle',
      'cargoPackageName=stellar_oracle_client',
      'library=reqwest',
      'edition=2021',
    ],
  },
  {
    name: 'go',
    generator: 'go',
    output: path.join(generatedRoot, 'go'),
    additionalProperties: [
      'packageName=stellaroracleclient',
      'packageVersion=1.0.0',
      'generateInterfaces=true',
    ],
  },
];

for (const config of generators) {
  fs.rmSync(config.output, { recursive: true, force: true });
  const args = [
    'openapi-generator-cli',
    'generate',
    '-i',
    specPath,
    '-g',
    config.generator,
    '-o',
    config.output,
    '--skip-validate-spec',
    '--additional-properties',
    config.additionalProperties.join(','),
  ];

  const result = spawnSync('npx', args, {
    cwd: sdkRoot,
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`Generated ${config.name} SDK in ${path.relative(sdkRoot, config.output)}`);
}
