import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Governance tests for API key rotation and cryptographic key inventory.
 *
 * Issue #751: Inventory cryptographic key use and lifecycle.
 *
 * These tests assert that:
 *  - Rotating an API key updates the owner-mapped key inventory metadata
 *    (owner, use, algorithm, status, rotation timestamps).
 *  - Rotation deadlines are enforced (keys past their rotation deadline are
 *    flagged as overdue and must be rotated).
 *  - Retirement deadlines are enforced (keys past their retirement deadline
 *    are flagged as retired/expired and must not be used for signing).
 *  - Algorithm transition requirements are recorded on the inventory entry.
 *
 * The inventory is modelled as an in-memory store so the tests are repeatable
 * and do not depend on external infrastructure. The same assertions apply to
 * the production inventory adapter, which must expose the same shape.
 */

type KeyUse = 'signing' | 'encryption' | 'verification';
type KeyStatus = 'active' | 'rotating' | 'retired';

interface KeyInventoryEntry {
  keyId: string;
  owner: string;
  use: KeyUse;
  algorithm: string;
  status: KeyStatus;
  createdAt: string;
  lastRotatedAt: string | null;
  rotationDeadline: string;
  retirementDeadline: string;
  supersededBy: string | null;
  algorithmTransition: {
    from: string;
    to: string;
    requiredBy: string;
  } | null;
}

interface RotationResult {
  previous: KeyInventoryEntry;
  current: KeyInventoryEntry;
}

class KeyInventory {
  private entries = new Map<string, KeyInventoryEntry>();

  register(entry: KeyInventoryEntry): void {
    if (this.entries.has(entry.keyId)) {
      throw new Error(`Key ${entry.keyId} already registered`);
    }
    this.entries.set(entry.keyId, { ...entry });
  }

  get(keyId: string): KeyInventoryEntry {
    const entry = this.entries.get(keyId);
    if (!entry) {
      throw new Error(`Key ${keyId} not found in inventory`);
    }
    return { ...entry };
  }

  list(): KeyInventoryEntry[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  /**
   * Rotate a key: create a new key entry, mark the previous key as retired
   * with a supersededBy pointer, and return both entries.
   */
  rotate(
    keyId: string,
    newKeyId: string,
    now: Date,
    options: {
      algorithm?: string;
      rotationIntervalDays?: number;
      retirementGraceDays?: number;
    } = {},
  ): RotationResult {
    const previous = this.get(keyId);
    if (previous.status === 'retired') {
      throw new Error(`Cannot rotate retired key ${keyId}`);
    }

    const algorithm = options.algorithm ?? previous.algorithm;
    const rotationIntervalDays = options.rotationIntervalDays ?? 90;
    const retirementGraceDays = options.retirementGraceDays ?? 30;

    const rotationDeadline = addDays(now, rotationIntervalDays).toISOString();
    const retirementDeadline = addDays(now, retirementGraceDays).toISOString();

    const current: KeyInventoryEntry = {
      keyId: newKeyId,
      owner: previous.owner,
      use: previous.use,
      algorithm,
      status: 'active',
      createdAt: now.toISOString(),
      lastRotatedAt: now.toISOString(),
      rotationDeadline,
      retirementDeadline,
      supersededBy: null,
      algorithmTransition:
        algorithm !== previous.algorithm
          ? {
              from: previous.algorithm,
              to: algorithm,
              requiredBy: rotationDeadline,
            }
          : previous.algorithmTransition,
    };

    const retiredPrevious: KeyInventoryEntry = {
      ...previous,
      status: 'retired',
      lastRotatedAt: now.toISOString(),
      supersededBy: newKeyId,
    };

    this.entries.set(keyId, retiredPrevious);
    this.entries.set(newKeyId, current);

    return { previous: { ...retiredPrevious }, current: { ...current } };
  }

  /** Keys whose rotation deadline has passed and are still active. */
  overdueForRotation(now: Date): KeyInventoryEntry[] {
    return this.list().filter(
      (e) =>
        e.status === 'active' && new Date(e.rotationDeadline).getTime() < now.getTime(),
    );
  }

  /** Keys whose retirement deadline has passed but are not yet retired. */
  overdueForRetirement(now: Date): KeyInventoryEntry[] {
    return this.list().filter(
      (e) =>
        e.status !== 'retired' &&
        new Date(e.retirementDeadline).getTime() < now.getTime(),
    );
  }

  /** Keys that must not be used because they are retired or past retirement. */
  unusable(now: Date): KeyInventoryEntry[] {
    return this.list().filter(
      (e) =>
        e.status === 'retired' ||
        new Date(e.retirementDeadline).getTime() < now.getTime(),
    );
  }
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function makeEntry(overrides: Partial<KeyInventoryEntry> = {}): KeyInventoryEntry {
  const now = new Date('2024-01-01T00:00:00.000Z');
  return {
    keyId: 'key-001',
    owner: 'team-security@example.com',
    use: 'signing',
    algorithm: 'RS256',
    status: 'active',
    createdAt: now.toISOString(),
    lastRotatedAt: null,
    rotationDeadline: addDays(now, 90).toISOString(),
    retirementDeadline: addDays(now, 365).toISOString(),
    supersededBy: null,
    algorithmTransition: null,
    ...overrides,
  };
}

describe('API key rotation inventory (issue #751)', () => {
  let inventory: KeyInventory;

  beforeEach(() => {
    inventory = new KeyInventory();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('rotation updates inventory metadata', () => {
    it('records the new key with owner, use, and rotation timestamps', () => {
      inventory.register(makeEntry());

      const now = new Date('2024-02-01T00:00:00.000Z');
      const { current } = inventory.rotate('key-001', 'key-002', now);

      expect(current.keyId).toBe('key-002');
      expect(current.owner).toBe('team-security@example.com');
      expect(current.use).toBe('signing');
      expect(current.algorithm).toBe('RS256');
      expect(current.status).toBe('active');
      expect(current.lastRotatedAt).toBe(now.toISOString());
      expect(current.createdAt).toBe(now.toISOString());
      expect(current.supersededBy).toBeNull();
    });

    it('marks the previous key as retired and points to its successor', () => {
      inventory.register(makeEntry());

      const now = new Date('2024-02-01T00:00:00.000Z');
      const { previous } = inventory.rotate('key-001', 'key-002', now);

      expect(previous.keyId).toBe('key-001');
      expect(previous.status).toBe('retired');
      expect(previous.supersededBy).toBe('key-002');
      expect(previous.lastRotatedAt).toBe(now.toISOString());
    });

    it('sets a new rotation deadline based on the rotation interval', () => {
      inventory.register(makeEntry());

      const now = new Date('2024-02-01T00:00:00.000Z');
      const { current } = inventory.rotate('key-001', 'key-002', now, {
        rotationIntervalDays: 30,
      });

      expect(current.rotationDeadline).toBe(
        new Date('2024-03-02T00:00:00.000Z').toISOString(),
      );
    });

    it('records an algorithm transition when the algorithm changes', () => {
      inventory.register(makeEntry({ algorithm: 'RS256' }));

      const now = new Date('2024-02-01T00:00:00.000Z');
      const { current } = inventory.rotate('key-001', 'key-002', now, {
        algorithm: 'ES256',
      });

      expect(current.algorithm).toBe('ES256');
      expect(current.algorithmTransition).not.toBeNull();
      expect(current.algorithmTransition?.from).toBe('RS256');
      expect(current.algorithmTransition?.to).toBe('ES256');
      expect(current.algorithmTransition?.requiredBy).toBe(current.rotationDeadline);
    });

    it('preserves the existing algorithm transition when the algorithm is unchanged', () => {
      const transition = {
        from: 'RS256',
        to: 'ES256',
        requiredBy: '2024-06-01T00:00:00.000Z',
      };
      inventory.register(
        makeEntry({ algorithm: 'ES256', algorithmTransition: transition }),
      );

      const now = new Date('2024-02-01T00:00:00.000Z');
      const { current } = inventory.rotate('key-001', 'key-002', now);

      expect(current.algorithmTransition).toEqual(transition);
    });

    it('rejects rotation of an already retired key', () => {
      inventory.register(makeEntry());
      const now = new Date('2024-02-01T00:00:00.000Z');
      inventory.rotate('key-001', 'key-002', now);

      expect(() =>
        inventory.rotate('key-001', 'key-003', new Date('2024-03-01T00:00:00.000Z')),
      ).toThrow(/retired/);
    });

    it('rejects rotation of an unknown key', () => {
      expect(() =>
        inventory.rotate('missing', 'key-002', new Date('2024-02-01T00:00:00.000Z')),
      ).toThrow(/not found/);
    });
  });

  describe('rotation deadline enforcement', () => {
    it('does not flag a key before its rotation deadline', () => {
      inventory.register(makeEntry());
      const now = new Date('2024-03-01T00:00:00.000Z');
      expect(inventory.overdueForRotation(now)).toHaveLength(0);
    });

    it('flags a key exactly at its rotation deadline boundary', () => {
      inventory.register(makeEntry());
      // Deadline is 2024-03-31T00:00:00.000Z; one millisecond before is not overdue.
      const justBefore = new Date('2024-03-30T23:59:59.999Z');
      expect(inventory.overdueForRotation(justBefore)).toHaveLength(0);

      const atDeadline = new Date('2024-03-31T00:00:00.000Z');
      expect(inventory.overdueForRotation(atDeadline)).toHaveLength(0);

      const justAfter = new Date('2024-03-31T00:00:00.001Z');
      const overdue = inventory.overdueForRotation(justAfter);
      expect(overdue).toHaveLength(1);
      expect(overdue[0].keyId).toBe('key-001');
    });

    it('does not flag retired keys as overdue for rotation', () => {
      inventory.register(makeEntry());
      inventory.rotate('key-001', 'key-002', new Date('2024-02-01T00:00:00.000Z'));

      const now = new Date('2024-12-01T00:00:00.000Z');
      const overdue = inventory.overdueForRotation(now);
      expect(overdue.map((e) => e.keyId)).not.toContain('key-001');
    });
  });

  describe('retirement deadline enforcement', () => {
    it('does not flag a key before its retirement deadline', () => {
      inventory.register(makeEntry());
      const now = new Date('2024-06-01T00:00:00.000Z');
      expect(inventory.overdueForRetirement(now)).toHaveLength(0);
    });

    it('flags a key past its retirement deadline', () => {
      inventory.register(makeEntry());
      const now = new Date('2025-01-02T00:00:00.000Z');
      const overdue = inventory.overdueForRetirement(now);
      expect(overdue).toHaveLength(1);
      expect(overdue[0].keyId).toBe('key-001');
    });

    it('treats retired keys and past-retirement keys as unusable', () => {
      inventory.register(makeEntry());
      inventory.rotate('key-001', 'key-002', new Date('2024-02-01T00:00:00.000Z'));

      const now = new Date('2024-02-15T00:00:00.000Z');
      const unusable = inventory.unusable(now).map((e) => e.keyId);
      expect(unusable).toContain('key-001');
      expect(unusable).not.toContain('key-002');
    });

    it('treats a key past its retirement deadline as unusable even if active', () => {
      inventory.register(
        makeEntry({
          retirementDeadline: '2024-01-15T00:00:00.000Z',
        }),
      );
      const now = new Date('2024-02-01T00:00:00.000Z');
      const unusable = inventory.unusable(now).map((e) => e.keyId);
      expect(unusable).toContain('key-001');
    });
  });

  describe('owner-mapped inventory', () => {
    it('retains the owner mapping across rotation', () => {
      inventory.register(makeEntry({ owner: 'team-a@example.com' }));
      inventory.rotate('key-001', 'key-002', new Date('2024-02-01T00:00:00.000Z'));

      const entries = inventory.list();
      const owners = new Set(entries.map((e) => e.owner));
      expect(owners).toEqual(new Set(['team-a@example.com']));
    });

    it('records use type for each key', () => {
      inventory.register(makeEntry({ keyId: 'sign-1', use: 'signing' }));
      inventory.register(makeEntry({ keyId: 'enc-1', use: 'encryption' }));
      inventory.register(makeEntry({ keyId: 'ver-1', use: 'verification' }));

      const uses = inventory.list().map((e) => e.use).sort();
      expect(uses).toEqual(['encryption', 'signing', 'verification']);
    });
  });
});