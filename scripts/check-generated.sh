#!/usr/bin/env sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

npm run generate:api-client

if ! git diff --quiet -- api/openapi.json sdk/src/generated; then
  echo "ERROR: Generated API client artifacts are out of date."
  echo "Run 'npm run generate:api-client' and commit the changes."
  git diff --stat -- api/openapi.json sdk/src/generated
  exit 1
fi

echo "Generated API client artifacts are up to date."
