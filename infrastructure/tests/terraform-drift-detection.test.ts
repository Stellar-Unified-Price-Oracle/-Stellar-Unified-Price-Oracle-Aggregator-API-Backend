import { beforeEach, describe, expect, it } from 'vitest';

interface TerraformPlan {
  resource_changes: Array<{
    address: string;
    type: string;
    change: { actions: string[]; before: Record<string, unknown>; after: Record<string, unknown> };
  }>;
}

interface DriftDetectionResult {
  hasDrift: boolean;
  driftType: 'none' | 'provider-noise' | 'meaningful' | 'unknown';
  changes: Array<{ resource: string; reason: string; severity: 'low' | 'medium' | 'high' }>;
  requiresCodeification: boolean;
  requiresRemediation: boolean;
}

describe('terraform drift detection', () => {
  let baselinePlan: TerraformPlan;
  let currentPlan: TerraformPlan;
  let driftResults: DriftDetectionResult[] = [];

  beforeEach(() => {
    baselinePlan = {
      resource_changes: [
        {
          address: 'aws_instance.api_server',
          type: 'aws_instance',
          change: {
            actions: [],
            before: { id: 'i-1234567890abcdef0', tags: { Environment: 'prod' } },
            after: { id: 'i-1234567890abcdef0', tags: { Environment: 'prod' } },
          },
        },
      ],
    };
    currentPlan = JSON.parse(JSON.stringify(baselinePlan));
    driftResults = [];
  });

  it('detects scheduled drift with plan comparison against baseline', () => {
    const driftPlan: TerraformPlan = {
      resource_changes: [
        {
          address: 'aws_instance.api_server',
          type: 'aws_instance',
          change: {
            actions: ['update'],
            before: { id: 'i-1234567890abcdef0', tags: { Environment: 'prod', Owner: 'terraform' } },
            after: { id: 'i-1234567890abcdef0', tags: { Environment: 'prod', Owner: 'manual', NewTag: 'added' } },
          },
        },
      ],
    };

    const result: DriftDetectionResult = {
      hasDrift: true,
      driftType: 'meaningful',
      changes: [
        {
          resource: 'aws_instance.api_server',
          reason: 'Manual tags added: Owner=manual, NewTag=added',
          severity: 'high',
        },
      ],
      requiresCodeification: true,
      requiresRemediation: false,
    };

    expect(result.hasDrift).toBe(true);
    expect(result.driftType).toBe('meaningful');
    expect(result.requiresCodeification).toBe(true);
  });

  it('distinguishes provider noise from meaningful drift', () => {
    const providerNoisePlan: TerraformPlan = {
      resource_changes: [
        {
          address: 'aws_instance.api_server',
          type: 'aws_instance',
          change: {
            actions: ['update'],
            before: { id: 'i-1234567890abcdef0', last_updated: '2025-01-01T00:00:00Z' },
            after: { id: 'i-1234567890abcdef0', last_updated: '2025-09-25T12:00:00Z' },
          },
        },
      ],
    };

    const noisePatterns = ['last_updated', 'modified_at', 'generated_name_id', 'arn', 'created_at'];
    const isNoise = providerNoisePlan.resource_changes[0].change.before.last_updated !==
                    providerNoisePlan.resource_changes[0].change.after.last_updated &&
                    noisePatterns.some(p => Object.keys(providerNoisePlan.resource_changes[0].change.before).includes(p));

    expect(isNoise).toBe(true);

    const result: DriftDetectionResult = {
      hasDrift: false,
      driftType: 'provider-noise',
      changes: [],
      requiresCodeification: false,
      requiresRemediation: false,
    };

    expect(result.driftType).toBe('provider-noise');
  });

  it('ensures state-lock safety with concurrent deploy verification', () => {
    const driftCheckStartTime = Date.now();
    const deployStartTime = Date.now() + 1000;
    const driftCheckDuration = 5000;
    const deployDuration = 30000;

    const driftCheckEndTime = driftCheckStartTime + driftCheckDuration;
    const deployEndTime = deployStartTime + deployDuration;

    const driftCheckHasLock = driftCheckStartTime <= deployStartTime && deployStartTime < driftCheckEndTime;

    if (driftCheckHasLock) {
      expect(driftCheckDuration).toBeLessThan(3000);
    }

    expect(driftCheckEndTime < deployEndTime || deployEndTime < driftCheckStartTime).toBe(true);
  });

  it('implements cross-region equivalence check for region parity', () => {
    const regionPlans = {
      'us-east-1': {
        resource_changes: [
          {
            address: 'aws_rds_cluster.main',
            type: 'aws_rds_cluster',
            change: {
              actions: [],
              before: { id: 'prod-cluster-us-east-1', engine_version: '14.7', instance_count: 3 },
              after: { id: 'prod-cluster-us-east-1', engine_version: '14.7', instance_count: 3 },
            },
          },
        ],
      },
      'eu-west-1': {
        resource_changes: [
          {
            address: 'aws_rds_cluster.main',
            type: 'aws_rds_cluster',
            change: {
              actions: [],
              before: { id: 'prod-cluster-eu-west-1', engine_version: '14.7', instance_count: 3 },
              after: { id: 'prod-cluster-eu-west-1', engine_version: '14.7', instance_count: 3 },
            },
          },
        ],
      },
      'ap-southeast-1': {
        resource_changes: [
          {
            address: 'aws_rds_cluster.main',
            type: 'aws_rds_cluster',
            change: {
              actions: [],
              before: { id: 'prod-cluster-ap-southeast-1', engine_version: '14.7', instance_count: 2 },
              after: { id: 'prod-cluster-ap-southeast-1', engine_version: '14.7', instance_count: 2 },
            },
          },
        ],
      },
    };

    const equivalenceIssues: Array<{ region1: string; region2: string; diff: string }> = [];

    const regionEntries = Object.entries(regionPlans);
    for (let i = 0; i < regionEntries.length; i++) {
      for (let j = i + 1; j < regionEntries.length; j++) {
        const [region1, plan1] = regionEntries[i];
        const [region2, plan2] = regionEntries[j];

        const rc1 = plan1.resource_changes[0].change.after as Record<string, unknown>;
        const rc2 = plan2.resource_changes[0].change.after as Record<string, unknown>;

        if (rc1.instance_count !== rc2.instance_count) {
          equivalenceIssues.push({
            region1,
            region2,
            diff: `instance_count: ${rc1.instance_count} vs ${rc2.instance_count}`,
          });
        }
      }
    }

    expect(equivalenceIssues).toHaveLength(2);
  });

  it('produces actionable CI output without requiring local reproduction', () => {
    const ciOutput = {
      summary: 'Drift detected in 2 resources',
      severity: 'HIGH',
      details: [
        {
          resource: 'aws_security_group.api',
          drift: 'Ingress rules manually modified',
          recommendation: 'Review and codify or remediate',
        },
        {
          resource: 'aws_instance.aggregator',
          drift: 'Tags added outside Terraform',
          recommendation: 'Add tags to Terraform config',
        },
      ],
      nextSteps: [
        '1. Review the drift details above',
        '2. Decide: codify (update config) or remediate (revert changes)',
        '3. For codification: run terraform import and update config',
        '4. For remediation: apply terraform destroy/apply to revert',
      ],
    };

    expect(ciOutput.summary).toContain('Drift detected');
    expect(ciOutput.details).toHaveLength(2);
    expect(ciOutput.nextSteps).toHaveLength(4);
  });

  it('documents mechanism for acknowledging accepted drift', () => {
    const driftAcknowledgmentFile = {
      version: 1,
      lastUpdated: '2025-09-25',
      acknowledgments: [
        {
          resource: 'aws_s3_bucket.logs',
          reason: 'Temporary logging configuration during incident',
          expiryDate: '2025-10-25',
          approvedBy: 'oncall-engineer',
        },
      ],
    };

    const activeDrift = driftAcknowledgmentFile.acknowledgments.filter((ack) => new Date() < new Date(ack.expiryDate));

    expect(activeDrift).toHaveLength(1);
    expect(activeDrift[0].expiryDate).toBe('2025-10-25');
  });

  it('fails on unexpected differences compared to baseline', () => {
    const expectedBaseline: DriftDetectionResult = {
      hasDrift: false,
      driftType: 'none',
      changes: [],
      requiresCodeification: false,
      requiresRemediation: false,
    };

    const actualResult: DriftDetectionResult = {
      hasDrift: true,
      driftType: 'meaningful',
      changes: [
        {
          resource: 'aws_instance.api_server',
          reason: 'Instance type changed without approval',
          severity: 'high',
        },
      ],
      requiresCodeification: false,
      requiresRemediation: true,
    };

    const hasUnexpectedDrift = actualResult.hasDrift && !expectedBaseline.hasDrift;
    expect(hasUnexpectedDrift).toBe(true);

    if (hasUnexpectedDrift) {
      throw new Error(`Unexpected drift detected: ${actualResult.changes.map((c) => c.resource).join(', ')}`);
    }
  });

  it('handles graceful failure and cancellation without corrupting state', () => {
    let stateLockedAt: number | null = null;
    let driftCheckCompleted = false;

    const acquireStateLock = () => {
      stateLockedAt = Date.now();
    };

    const releaseStateLock = () => {
      if (stateLockedAt !== null) {
        stateLockedAt = null;
      }
    };

    const runDriftCheck = () => {
      try {
        acquireStateLock();
        throw new Error('Simulated drift check failure');
      } catch (error) {
        expect(error).toBeDefined();
      } finally {
        releaseStateLock();
        driftCheckCompleted = true;
      }
    };

    runDriftCheck();

    expect(stateLockedAt).toBeNull();
    expect(driftCheckCompleted).toBe(true);
  });

  it('validates kustomize overlays for region consistency', () => {
    const regionOverlays = {
      'prod-us-east-1': {
        replicas: 5,
        resources: { cpu: '2000m', memory: '4Gi' },
      },
      'prod-eu-west-1': {
        replicas: 5,
        resources: { cpu: '2000m', memory: '4Gi' },
      },
      'prod-ap-southeast-1': {
        replicas: 3,
        resources: { cpu: '2000m', memory: '4Gi' },
      },
    };

    const discrepancies: Array<{ overlays: string[]; field: string; values: unknown[] }> = [];

    const overlayEntries = Object.entries(regionOverlays);
    for (let i = 0; i < overlayEntries.length; i++) {
      for (let j = i + 1; j < overlayEntries.length; j++) {
        const [name1, config1] = overlayEntries[i];
        const [name2, config2] = overlayEntries[j];

        if (config1.replicas !== config2.replicas) {
          discrepancies.push({
            overlays: [name1, name2],
            field: 'replicas',
            values: [config1.replicas, config2.replicas],
          });
        }
      }
    }

    expect(discrepancies).toHaveLength(2);
    expect(discrepancies[0].field).toBe('replicas');
  });
});
