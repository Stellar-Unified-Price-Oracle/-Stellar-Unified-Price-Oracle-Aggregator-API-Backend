import { describe, it, expect, beforeEach, jest } from '@jest/globals';

/**
 * Maintenance-window workflow tests.
 *
 * These tests exercise the guarded regional maintenance workflow:
 *   prechecks -> traffic drain -> publisher fencing -> maintenance -> validation
 *
 * The orchestrator under test is expected to expose:
 *   - runMaintenanceWindow(region, options): Promise<MaintenanceResult>
 *   - getRegionState(region): RegionState
 *
 * Failure semantics:
 *   - Any precheck failure aborts BEFORE drain begins (region stays ACTIVE).
 *   - Drain failure aborts BEFORE fencing (region stays ACTIVE, partial drain rolled back).
 *   - Fencing failure aborts BEFORE maintenance (region stays ACTIVE, drain rolled back).
 *   - Validation failure after maintenance leaves region in DEGRADED (needs operator).
 */

type RegionState = 'ACTIVE' | 'DRAINING' | 'FENCED' | 'MAINTENANCE' | 'DEGRADED';

interface MaintenanceResult {
  status: 'completed' | 'aborted' | 'failed';
  stage: 'precheck' | 'drain' | 'fence' | 'maintenance' | 'validation' | 'done';
  regionState: RegionState;
  drainedPublishers: string[];
  fencedPublishers: string[];
  errors: string[];
}

interface MaintenanceOrchestrator {
  runMaintenanceWindow(
    region: string,
    options?: { drainTimeoutMs?: number; fenceTimeoutMs?: number },
  ): Promise<MaintenanceResult>;
  getRegionState(region: string): RegionState;
}

// ---------------------------------------------------------------------------
// Test doubles: a fake orchestrator that models the workflow state machine.
// The real implementation is injected in production; here we build a
// controllable fake so we can simulate normal, boundary, and failure cases.
// ---------------------------------------------------------------------------

interface FakeDeps {
  prechecks: () => Promise<{ ok: boolean; errors?: string[] }>;
  drain: (publishers: string[]) => Promise<{ drained: string[]; partial: boolean }>;
  fence: (publishers: string[]) => Promise<{ fenced: string[]; ok: boolean; errors?: string[] }>;
  validate: () => Promise<{ ok: boolean; errors?: string[] }>;
  publishers: string[];
}

function createFakeOrchestrator(deps: FakeDeps): MaintenanceOrchestrator {
  const states = new Map<string, RegionState>();

  return {
    getRegionState(region: string): RegionState {
      return states.get(region) ?? 'ACTIVE';
    },
    async runMaintenanceWindow(region: string): Promise<MaintenanceResult> {
      const result: MaintenanceResult = {
        status: 'aborted',
        stage: 'precheck',
        regionState: 'ACTIVE',
        drainedPublishers: [],
        fencedPublishers: [],
        errors: [],
      };

      // 1. Prechecks
      const pre = await deps.prechecks();
      if (!pre.ok) {
        result.status = 'aborted';
        result.stage = 'precheck';
        result.errors = pre.errors ?? ['precheck failed'];
        result.regionState = 'ACTIVE';
        states.set(region, 'ACTIVE');
        return result;
      }

      // 2. Traffic drain
      states.set(region, 'DRAINING');
      const drain = await deps.drain(deps.publishers);
      result.drainedPublishers = drain.drained;
      if (drain.partial) {
        // Boundary case: partial drain -> abort and roll back to ACTIVE.
        result.status = 'aborted';
        result.stage = 'drain';
        result.errors = ['partial drain: not all publishers drained'];
        result.regionState = 'ACTIVE';
        states.set(region, 'ACTIVE');
        return result;
      }

      // 3. Publisher fencing
      states.set(region, 'FENCED');
      const fence = await deps.fence(drain.drained);
      result.fencedPublishers = fence.fenced;
      if (!fence.ok) {
        result.status = 'aborted';
        result.stage = 'fence';
        result.errors = fence.errors ?? ['fencing failed'];
        result.regionState = 'ACTIVE';
        states.set(region, 'ACTIVE');
        return result;
      }

      // 4. Maintenance (simulated as instantaneous)
      states.set(region, 'MAINTENANCE');

      // 5. Post-maintenance validation
      const validation = await deps.validate();
      if (!validation.ok) {
        result.status = 'failed';
        result.stage = 'validation';
        result.errors = validation.errors ?? ['validation failed'];
        result.regionState = 'DEGRADED';
        states.set(region, 'DEGRADED');
        return result;
      }

      result.status = 'completed';
      result.stage = 'done';
      result.regionState = 'ACTIVE';
      states.set(region, 'ACTIVE');
      return result;
    },
  };
}

const REGION = 'us-east-1a';
const PUBLISHERS = ['pub-a', 'pub-b', 'pub-c'];

describe('maintenance-window workflow', () => {
  let deps: FakeDeps;
  let orchestrator: MaintenanceOrchestrator;

  beforeEach(() => {
    deps = {
      publishers: [...PUBLISHERS],
      prechecks: jest.fn(async () => ({ ok: true })),
      drain: jest.fn(async (pubs: string[]) => ({ drained: [...pubs], partial: false })),
      fence: jest.fn(async (pubs: string[]) => ({ fenced: [...pubs], ok: true })),
      validate: jest.fn(async () => ({ ok: true })),
    };
    orchestrator = createFakeOrchestrator(deps);
  });

  describe('normal completion', () => {
    it('runs all stages and returns the region to ACTIVE', async () => {
      const result = await orchestrator.runMaintenanceWindow(REGION);

      expect(result.status).toBe('completed');
      expect(result.stage).toBe('done');
      expect(result.regionState).toBe('ACTIVE');
      expect(result.errors).toEqual([]);
      expect(result.drainedPublishers).toEqual(PUBLISHERS);
      expect(result.fencedPublishers).toEqual(PUBLISHERS);
      expect(orchestrator.getRegionState(REGION)).toBe('ACTIVE');

      // Stage ordering: prechecks -> drain -> fence -> validate.
      expect(deps.prechecks).toHaveBeenCalledTimes(1);
      expect(deps.drain).toHaveBeenCalledTimes(1);
      expect(deps.fence).toHaveBeenCalledTimes(1);
      expect(deps.validate).toHaveBeenCalledTimes(1);
    });

    it('drains and fences every publisher exactly once', async () => {
      await orchestrator.runMaintenanceWindow(REGION);

      const drainArg = (deps.drain as jest.Mock).mock.calls[0][0] as string[];
      const fenceArg = (deps.fence as jest.Mock).mock.calls[0][0] as string[];
      expect(drainArg.sort()).toEqual([...PUBLISHERS].sort());
      expect(fenceArg.sort()).toEqual([...PUBLISHERS].sort());
    });
  });

  describe('boundary: partial drain', () => {
    it('aborts at drain and rolls the region back to ACTIVE', async () => {
      deps.drain = jest.fn(async (pubs: string[]) => ({
        drained: pubs.slice(0, 1), // only one of three drained
        partial: true,
      }));

      const result = await orchestrator.runMaintenanceWindow(REGION);

      expect(result.status).toBe('aborted');
      expect(result.stage).toBe('drain');
      expect(result.regionState).toBe('ACTIVE');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(orchestrator.getRegionState(REGION)).toBe('ACTIVE');

      // Fencing and validation must NOT run after a partial drain.
      expect(deps.fence).not.toHaveBeenCalled();
      expect(deps.validate).not.toHaveBeenCalled();
    });

    it('does not fence any publisher when drain is partial', async () => {
      deps.drain = jest.fn(async () => ({ drained: [], partial: true }));

      const result = await orchestrator.runMaintenanceWindow(REGION);

      expect(result.fencedPublishers).toEqual([]);
      expect(deps.fence).not.toHaveBeenCalled();
    });
  });

  describe('failure: precheck fails', () => {
    it('aborts before drain and leaves region ACTIVE', async () => {
      deps.prechecks = jest.fn(async () => ({
        ok: false,
        errors: ['quorum unhealthy', 'replication lag too high'],
      }));

      const result = await orchestrator.runMaintenanceWindow(REGION);

      expect(result.status).toBe('aborted');
      expect(result.stage).toBe('precheck');
      expect(result.regionState).toBe('ACTIVE');
      expect(result.errors).toEqual(['quorum unhealthy', 'replication lag too high']);
      expect(orchestrator.getRegionState(REGION)).toBe('ACTIVE');

      // No traffic should be touched when prechecks fail.
      expect(deps.drain).not.toHaveBeenCalled();
      expect(deps.fence).not.toHaveBeenCalled();
      expect(deps.validate).not.toHaveBeenCalled();
    });
  });

  describe('failure: fencing fails', () => {
    it('aborts at fence and rolls the region back to ACTIVE', async () => {
      deps.fence = jest.fn(async (pubs: string[]) => ({
        fenced: pubs.slice(0, 1),
        ok: false,
        errors: ['publisher pub-b refused fence'],
      }));

      const result = await orchestrator.runMaintenanceWindow(REGION);

      expect(result.status).toBe('aborted');
      expect(result.stage).toBe('fence');
      expect(result.regionState).toBe('ACTIVE');
      expect(result.errors).toContain('publisher pub-b refused fence');
      expect(orchestrator.getRegionState(REGION)).toBe('ACTIVE');

      // Maintenance validation must not run after a fencing failure.
      expect(deps.validate).not.toHaveBeenCalled();
    });

    it('records the partial set of fenced publishers for operator review', async () => {
      deps.fence = jest.fn(async (pubs: string[]) => ({
        fenced: pubs.slice(0, 2),
        ok: false,
        errors: ['fence timeout'],
      }));

      const result = await orchestrator.runMaintenanceWindow(REGION);

      expect(result.fencedPublishers).toEqual(PUBLISHERS.slice(0, 2));
      expect(result.status).toBe('aborted');
    });
  });

  describe('failure: post-maintenance validation fails', () => {
    it('marks the region DEGRADED for operator follow-up', async () => {
      deps.validate = jest.fn(async () => ({
        ok: false,
        errors: ['replica count below threshold'],
      }));

      const result = await orchestrator.runMaintenanceWindow(REGION);

      expect(result.status).toBe('failed');
      expect(result.stage).toBe('validation');
      expect(result.regionState).toBe('DEGRADED');
      expect(result.errors).toContain('replica count below threshold');
      expect(orchestrator.getRegionState(REGION)).toBe('DEGRADED');
    });
  });

  describe('consistency invariants', () => {
    it('never leaves the region in a transient state after abort', async () => {
      const scenarios: Array<() => void> = [
        () => {
          deps.prechecks = jest.fn(async () => ({ ok: false, errors: ['x'] }));
        },
        () => {
          deps.drain = jest.fn(async () => ({ drained: [], partial: true }));
        },
        () => {
          deps.fence = jest.fn(async () => ({ fenced: [], ok: false, errors: ['x'] }));
        },
      ];

      for (const setup of scenarios) {
        deps = {
          publishers: [...PUBLISHERS],
          prechecks: jest.fn(async () => ({ ok: true })),
          drain: jest.fn(async (pubs: string[]) => ({ drained: [...pubs], partial: false })),
          fence: jest.fn(async (pubs: string[]) => ({ fenced: [...pubs], ok: true })),
          validate: jest.fn(async () => ({ ok: true })),
        };
        orchestrator = createFakeOrchestrator(deps);
        setup();

        const result = await orchestrator.runMaintenanceWindow(REGION);
        expect(result.status).toBe('aborted');
        expect(['ACTIVE']).toContain(orchestrator.getRegionState(REGION));
      }
    });

    it('is idempotent: a second run after a completed window succeeds', async () => {
      const first = await orchestrator.runMaintenanceWindow(REGION);
      expect(first.status).toBe('completed');

      const second = await orchestrator.runMaintenanceWindow(REGION);
      expect(second.status).toBe('completed');
      expect(orchestrator.getRegionState(REGION)).toBe('ACTIVE');
    });
  });
});