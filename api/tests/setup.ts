/**
 * Lightweight setup shim for unit-level feature tests.
 *
 * The tests under `tests/features/` build in-memory Express apps and never
 * touch a database, so they do not need the testcontainers harness used by the
 * e2e suite (`tests/e2e/setup.ts`). Keeping this shim resolves their imports
 * without pulling Docker into the default `vitest run` path.
 */
export async function setupE2E(): Promise<void> {
  // No external services required for these tests.
}

export async function teardownE2E(): Promise<void> {
  // No external services to tear down.
}
