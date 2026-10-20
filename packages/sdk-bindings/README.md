# @stellar-oracle/sdk-bindings

Owner: Developer ecosystem and integration.

## Typed feed metadata bindings

`schema/feed-metadata.schema.json` is the canonical feed metadata schema. `src/generated/feedMetadata.ts` is generated from it (types, field lists, and an `isFeedMetadata` runtime guard). Output is deterministic: no timestamps, and a schema hash is embedded.

```
node scripts/generate-feed-metadata-bindings.mjs          # regenerate
node scripts/generate-feed-metadata-bindings.mjs --check  # CI: fail on drift
node --test packages/sdk-bindings/tests
```

### Compatibility rules
- Additive changes (new optional field, new enum member) are minor; bump `x-schemaVersion` only for breaking changes (removing/renaming a field, narrowing a type, making a field required).
- The test suite pins the required field set, so removing one fails CI.
- Publishing: consumers import from `@stellar-oracle/sdk-bindings`; version the package with the schema version.

### Operations
- Monitoring: run the `--check` command in CI on any change touching the schema or the generated file.
- Rollout: change schema, regenerate, commit both together.
- Rollback: revert both files; no runtime service depends on the bindings.

## Checkpoint recovery
See `src/checkpoint.ts` (added separately, documented in `CHECKPOINT.md`).
