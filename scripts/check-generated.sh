#!/usr/bin/env sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

npm run generate:api-client
npm run generate:sdks

if ! git diff --quiet -- api/openapi.json sdk/src/generated sdk/generated; then
  echo "ERROR: Generated SDK artifacts are out of date."
  echo "Run 'npm run generate:api-client' and 'npm run generate:sdks' and commit the changes."
  git diff --stat -- api/openapi.json sdk/src/generated sdk/generated
  exit 1
fi

echo "Generated SDK artifacts are up to date."
