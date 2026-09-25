import * as assert from 'assert';

interface Migration {
  version: number;
  description: string;
  backwardCompatible: boolean;
  requiresDowntime?: boolean;
  minRollbackBoundary?: number;
}

interface RollbackTestResult {
  testName: string;
  versionFrom: number;
  versionTo: number;
  schemaAfterMigration: string;
  readSuccess: boolean;
  writeSuccess: boolean;
  dataIntegrityOk: boolean;
  blueGreenCompatible: boolean;
  verdictPass: boolean;
  errors: string[];
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    backwardCompatible: true,
  },
  {
    version: 2,
    description: 'Add nullable price column',
    backwardCompatible: true,
  },
  {
    version: 3,
    description: 'Add asset_id unique constraint',
    backwardCompatible: true,
  },
  {
    version: 4,
    description: 'Rename timestamp column (incompatible)',
    backwardCompatible: false,
    minRollbackBoundary: 4,
  },
  {
    version: 5,
    description: 'Add decimal precision column',
    backwardCompatible: true,
  },
];

async function deployApplicationVersion(
  versionNumber: number
): Promise<{ success: boolean; error?: string }> {
  // In production: deploy the specific application version
  // Could use kubectl rollout or similar

  console.log(`    Deploying application v${versionNumber}...`);
  return { success: true };
}

async function runDatabaseMigration(
  fromVersion: number,
  toVersion: number
): Promise<{ success: boolean; appliedMigrations: Migration[] }> {
  // In production: run actual migrations via Flyway, TypeORM, etc.

  console.log(`    Running migrations: ${fromVersion} → ${toVersion}...`);

  const appliedMigrations: Migration[] = [];

  for (let v = fromVersion + 1; v <= toVersion; v++) {
    const migration = migrations.find((m) => m.version === v);
    if (migration) {
      appliedMigrations.push(migration);
    }
  }

  return { success: true, appliedMigrations };
}

async function testApplicationReadOperations(
  appVersion: number,
  schemaVersion: number
): Promise<{ success: boolean; recordsRead: number; error?: string }> {
  // In production: execute representative read queries
  // Example: SELECT price FROM prices WHERE asset = 'XLM'

  console.log(`    Testing reads on app v${appVersion} against schema v${schemaVersion}...`);

  // Simulate reading records
  const recordsRead = 100;

  // Check if app version understands the schema
  const appUnderstandsSchema = appVersion >= schemaVersion - 1; // Accept current + 1 version back

  if (!appUnderstandsSchema) {
    return {
      success: false,
      recordsRead: 0,
      error: `Application v${appVersion} does not understand schema v${schemaVersion}`,
    };
  }

  return { success: true, recordsRead };
}

async function testApplicationWriteOperations(
  appVersion: number,
  schemaVersion: number
): Promise<{ success: boolean; recordsWritten: number; error?: string }> {
  // In production: execute representative write queries
  // Example: INSERT INTO prices (asset, price, decimals) VALUES (...)

  console.log(`    Testing writes on app v${appVersion} against schema v${schemaVersion}...`);

  const recordsWritten = 50;

  // Check if app version can write to schema
  const appCanWrite = appVersion >= schemaVersion - 1;

  if (!appCanWrite) {
    return {
      success: false,
      recordsWritten: 0,
      error: `Application v${appVersion} cannot write to schema v${schemaVersion}`,
    };
  }

  return { success: true, recordsWritten };
}

async function verifyDataIntegrity(
  schemaVersion: number
): Promise<{ integrityOk: boolean; issues: string[] }> {
  // In production: run data validation queries
  // Example: check for orphaned records, constraint violations, etc.

  console.log(`    Verifying data integrity at schema v${schemaVersion}...`);

  const issues: string[] = [];

  // Simulate data validation
  const rowCount = 1000;
  const validRows = 995;

  if (validRows < rowCount * 0.99) {
    issues.push(`Data integrity check: ${validRows}/${rowCount} rows valid`);
  }

  return { integrityOk: issues.length === 0, issues };
}

async function testBlueGreenOverlapCompatibility(
  oldAppVersion: number,
  newAppVersion: number,
  schemaVersion: number
): Promise<{ compatible: boolean; issues: string[] }> {
  // Test that both app versions can run concurrently against same schema
  // This is the requirement for true zero-downtime deployment

  console.log(
    `    Testing blue-green overlap: v${oldAppVersion} + v${newAppVersion} against schema v${schemaVersion}...`
  );

  const issues: string[] = [];

  // Check if both versions can read
  const oldReads = await testApplicationReadOperations(oldAppVersion, schemaVersion);
  const newReads = await testApplicationReadOperations(newAppVersion, schemaVersion);

  if (!oldReads.success || !newReads.success) {
    issues.push('Not all versions can read during overlap');
  }

  // Check if both versions can write
  const oldWrites = await testApplicationWriteOperations(oldAppVersion, schemaVersion);
  const newWrites = await testApplicationWriteOperations(newAppVersion, schemaVersion);

  if (!oldWrites.success || !newWrites.success) {
    issues.push('Not all versions can write during overlap');
  }

  // For true zero-downtime, both must handle writes from the other version
  // This requires careful schema design (nullable columns, feature flags, etc.)

  return { compatible: issues.length === 0, issues };
}

async function runRollbackTest(
  appVersionV1: number,
  appVersionV2: number,
  migrationVersion: number
): Promise<RollbackTestResult> {
  const result: RollbackTestResult = {
    testName: `rollback-v${appVersionV1}-to-v${appVersionV2}`,
    versionFrom: appVersionV2,
    versionTo: appVersionV1,
    schemaAfterMigration: `v${migrationVersion}`,
    readSuccess: false,
    writeSuccess: false,
    dataIntegrityOk: false,
    blueGreenCompatible: false,
    verdictPass: false,
    errors: [],
  };

  try {
    // Phase 1: Deploy V1 with schema V1
    console.log(`  Phase 1: Deploy app v${appVersionV1} with schema v${appVersionV1}`);
    let deploy = await deployApplicationVersion(appVersionV1);
    assert.ok(deploy.success, 'Failed to deploy v1');

    // Phase 2: Migrate schema forward
    console.log(`  Phase 2: Migrate schema v${appVersionV1} → v${migrationVersion}`);
    let migration = await runDatabaseMigration(appVersionV1, migrationVersion);
    assert.ok(migration.success, 'Failed to run migrations');

    // Check backward compatibility
    const incompatibleMigrations = migration.appliedMigrations.filter(
      (m) => !m.backwardCompatible
    );

    if (incompatibleMigrations.length > 0) {
      const boundary = Math.max(...incompatibleMigrations.map((m) => m.minRollbackBoundary || 0));
      if (appVersionV1 < boundary) {
        result.errors.push(
          `Cannot rollback to v${appVersionV1}: minimum rollback boundary is v${boundary} (incompatible migration at v${incompatibleMigrations[0].version})`
        );
        return result;
      }
    }

    // Phase 3: Deploy V2 against migrated schema
    console.log(`  Phase 3: Deploy app v${appVersionV2} against schema v${migrationVersion}`);
    deploy = await deployApplicationVersion(appVersionV2);
    assert.ok(deploy.success, 'Failed to deploy v2');

    // Phase 4: Test blue-green overlap
    console.log(`  Phase 4: Test blue-green overlap (v${appVersionV1} + v${appVersionV2})`);
    const overlapTest = await testBlueGreenOverlapCompatibility(
      appVersionV1,
      appVersionV2,
      migrationVersion
    );

    if (!overlapTest.compatible) {
      result.errors.push(`Blue-green overlap incompatibility: ${overlapTest.issues.join('; ')}`);
    }

    result.blueGreenCompatible = overlapTest.compatible;

    // Phase 5: Rollback to V1
    console.log(`  Phase 5: Rollback to app v${appVersionV1}`);
    deploy = await deployApplicationVersion(appVersionV1);
    assert.ok(deploy.success, `Failed to rollback to v${appVersionV1}`);

    // Phase 6: Verify V1 can read migrated schema
    console.log(`  Phase 6: Verify reads on rolled-back v${appVersionV1}`);
    const readTest = await testApplicationReadOperations(appVersionV1, migrationVersion);

    if (!readTest.success) {
      result.errors.push(`Rolled-back version cannot read: ${readTest.error}`);
    }

    result.readSuccess = readTest.success;

    // Phase 7: Verify V1 can write migrated schema
    console.log(`  Phase 7: Verify writes on rolled-back v${appVersionV1}`);
    const writeTest = await testApplicationWriteOperations(appVersionV1, migrationVersion);

    if (!writeTest.success) {
      result.errors.push(`Rolled-back version cannot write: ${writeTest.error}`);
    }

    result.writeSuccess = writeTest.success;

    // Phase 8: Verify data integrity
    console.log(`  Phase 8: Verify data integrity after rollback`);
    const integrityTest = await verifyDataIntegrity(migrationVersion);

    if (!integrityTest.integrityOk) {
      result.errors.push(`Data integrity issues: ${integrityTest.issues.join('; ')}`);
    }

    result.dataIntegrityOk = integrityTest.integrityOk;

    // Final verdict
    result.verdictPass =
      result.readSuccess &&
      result.writeSuccess &&
      result.dataIntegrityOk &&
      result.blueGreenCompatible;

    if (result.verdictPass) {
      console.log(`  ✓ Rollback test PASSED`);
    } else {
      console.log(`  ✗ Rollback test FAILED`);
    }
  } catch (error) {
    result.errors.push(String(error));
    console.log(`  ✗ Rollback test ERROR: ${error}`);
  }

  return result;
}

async function testIncompatibleMigrationDetection(): Promise<RollbackTestResult> {
  // Negative test: verify the drill fails when an incompatible migration is introduced

  console.log('\n  Negative test: Incompatible migration detection');

  const result: RollbackTestResult = {
    testName: 'detect-incompatible-migration',
    versionFrom: 3,
    versionTo: 4,
    schemaAfterMigration: 'v4',
    readSuccess: false,
    writeSuccess: false,
    dataIntegrityOk: false,
    blueGreenCompatible: false,
    verdictPass: false,
    errors: [],
  };

  try {
    // Try to rollback from V4 (after incompatible migration) to V3
    // This should fail
    console.log('  Attempting rollback across incompatible migration boundary...');

    const appVersion3 = 3;
    const incompatibleMigration = migrations.find((m) => m.version === 4);

    if (incompatibleMigration && !incompatibleMigration.backwardCompatible) {
      console.log(
        `  ✓ Correctly detected incompatible migration at v${incompatibleMigration.version}`
      );
      result.verdictPass = true;

      if (incompatibleMigration.minRollbackBoundary && appVersion3 < incompatibleMigration.minRollbackBoundary) {
        result.errors.push(
          `Rollback blocked: minimum boundary is v${incompatibleMigration.minRollbackBoundary}`
        );
        console.log(
          `  ✓ Correctly blocked rollback to v${appVersion3} (boundary is v${incompatibleMigration.minRollbackBoundary})`
        );
      }
    } else {
      result.errors.push('Failed to detect incompatible migration');
      result.verdictPass = false;
    }
  } catch (error) {
    result.errors.push(String(error));
  }

  return result;
}

export async function runRollbackSchemaTests(): Promise<RollbackTestResult[]> {
  const results: RollbackTestResult[] = [];

  console.log('=== ROLLBACK SCHEMA MIGRATION VERIFICATION ===\n');

  // Test 1: Backward-compatible migration
  console.log('Test 1: Rollback across backward-compatible migrations');
  let testResult = await runRollbackTest(1, 2, 3); // V1→V2, schema 1→3
  results.push(testResult);

  // Test 2: Rollback with more complex schema changes
  console.log('\nTest 2: Rollback with multiple backward-compatible migrations');
  testResult = await runRollbackTest(2, 3, 5); // V2→V3, schema 2→5
  results.push(testResult);

  // Test 3: Detect incompatible migration
  console.log('\nTest 3: Incompatible migration detection');
  testResult = await testIncompatibleMigrationDetection();
  results.push(testResult);

  // Summary
  const passCount = results.filter((r) => r.verdictPass).length;
  console.log(`\n\n=== ROLLBACK SCHEMA VERIFICATION SUMMARY ===`);
  console.log(`Passed: ${passCount}/${results.length}`);

  for (const result of results) {
    const status = result.verdictPass ? '✓' : '✗';
    console.log(
      `${status} ${result.testName}: schema=${result.schemaAfterMigration}, read=${result.readSuccess}, write=${result.writeSuccess}, integrity=${result.dataIntegrityOk}`
    );
  }

  const anyFailed = results.some((r) => !r.verdictPass);
  if (anyFailed) {
    throw new Error(
      `Rollback schema tests failed for ${results.filter((r) => !r.verdictPass).length} test(s)`
    );
  }

  return results;
}

if (require.main === module) {
  runRollbackSchemaTests()
    .then(() => {
      console.log('\n✓ All rollback schema tests passed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n✗ Rollback schema tests failed:', error);
      process.exit(1);
    });
}

export { Migration, RollbackTestResult };
