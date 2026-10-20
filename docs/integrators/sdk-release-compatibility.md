# SDK release compatibility gate

**Owner:** SDK maintainers. **Status:** Adopted.

`.github/workflows/sdk-release-compat-gate.yml` runs on every `sdk-v*` tag (and manually). It executes `scripts/sdk-release-compat-check.mjs`, which:

1. Requires the tag to be `sdk-vX.Y.Z` and equal to the `sdk/package.json` version.
2. Reads the server version (`api/package.json`) and contract version (`contracts/price-oracle/Cargo.toml`).
3. Checks them against `sdk/compat.json` (`supportedServer` ranges, `schemaVersions`, `contractAbi` majors).
4. Fails the job (exit 1) on any mismatch or missing policy; otherwise writes `sdk-release-notes.md` listing supported server, schema, and contract versions, uploaded as a workflow artifact.

## compat.json example
```json
{ "supportedServer": [">=2.0.0 <3.0.0"], "schemaVersions": ["v2"], "contractAbi": ["0"] }
```

## Rollout and rollback
To make publishing depend on the gate, add `needs: compat-gate` via a `workflow_run`/reusable-workflow change to `sdk-publish.yml` (a follow-up maintainer edit; the existing workflow is untouched here). Until then it runs as a parallel required check on tags. Rollback: delete the workflow file; nothing else depends on it.

## Failure cases covered
Bad or mismatched tag, missing `sdk/package.json` or `compat.json`, server major outside the supported range, contract ABI major not declared. Contract ABI and API behavior tests remain in the existing CI jobs (`docs/CONTRACT_VERSIONING.md`, `docs/api-versioning-policy.md`).
