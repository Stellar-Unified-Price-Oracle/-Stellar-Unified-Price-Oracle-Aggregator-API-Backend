# Generated API fixtures

`api-fixtures.json` is generated from the published schemas in `api/openapi.json`
by `scripts/generate-schema-fixtures.mjs`. Owner: Developer ecosystem and integration.

- Regenerate: `node scripts/generate-schema-fixtures.mjs`
- CI/staleness check: `node scripts/generate-schema-fixtures.mjs --check`
- Self-test: `node --test fixtures/generated/fixtures.test.mjs`

Each schema has `valid`, `empty_object` (failure case: required data missing) and
`empty_<arrayProp>` (boundary case) entries. Output is deterministic (no clock, no randomness).

## Consumers

API tests, SDK tests and consumer contract tests should import this single JSON file
rather than hand-writing payloads, e.g. `JSON.parse(fs.readFileSync('fixtures/generated/api-fixtures.json'))`.
The conformance kit and sample applications use the same file.

## Compatibility, monitoring, rollout, rollback

- A schema change in `api/openapi.json` makes `--check` fail until fixtures are regenerated and committed in the same PR; review the diff as a contract change.
- Add new schemas by appending to `SCHEMAS` in the generator; existing keys are never renamed so consumers keep working.
- Rollback: revert the fixture commit; fixtures are test data only and have no runtime impact.
