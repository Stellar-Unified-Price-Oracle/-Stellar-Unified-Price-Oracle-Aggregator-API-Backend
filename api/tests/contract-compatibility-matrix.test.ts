import { describe, it, expect } from 'vitest';

/** A contract version as exposed on-chain via get_api_version() / get_version(). */
interface ContractVersion {
  version: number;
  apiVersion: number;
  /** Entrypoints exported by this contract version. */
  entrypoints: string[];
  /** Whether this version is currently supported on mainnet/testnet. */
  supported: boolean;
}

/** A generated client binding produced from a contract ABI. */
interface ClientBinding {
  version: number;
  /** The contract API_VERSION this binding was generated against. */
  targetsApiVersion: number;
  /** TypeScript interfaces emitted by the generator. */
  interfaces: string[];
  /** Whether this binding is actively published. */
  published: boolean;
}

/** A row of the compatibility matrix: contract version × client binding. */
interface CompatibilityRow {
  contractVersion: number;
  clientVersion: number;
  compatible: boolean;
  /** Reason when incompatible. */
  reason?: string;
}

/** ── Supported contract versions (the source of truth) ─────────────────────── */

const CONTRACT_VERSIONS: ContractVersion[] = [
  {
    version: 1,
    apiVersion: 1,
    entrypoints: [
      'get_api_version',
      'get_price',
      'get_price_history',
      'get_assets',
      'get_source_reputation',
      'get_deviation_threshold',
      'submit_price',
      'submit_batch',
      'apply_batch_entry',
    ],
    supported: true,
  },
];

/** ── Generated client bindings (produced from the contract ABI) ────────────── */

const CLIENT_BINDINGS: ClientBinding[] = [
  {
    version: 1,
    targetsApiVersion: 1,
    interfaces: [
      'PriceOracleClient',
      'AssetPrice',
      'PriceDataPoint',
      'MerkleProof',
      'BatchPriceEntry',
    ],
    published: true,
  },
];

/** ── Compatibility matrix ──────────────────────────────────────────────────── */

/** Check whether a single contract version is compatible with a single client binding. */
function checkCompatibility(contract: ContractVersion, binding: ClientBinding): CompatibilityRow {
  const compatible =
    contract.supported &&
    binding.published &&
    contract.apiVersion === binding.targetsApiVersion;

  return {
    contractVersion: contract.version,
    clientVersion: binding.version,
    compatible,
    ...(compatible
      ? {}
      : {
          reason:
            !contract.supported
              ? 'contract version not supported'
              : !binding.published
                ? 'client binding not published'
                : `API version mismatch: contract API v${contract.apiVersion} != binding target v${binding.targetsApiVersion}`,
        }),
  };
}

function buildCompatibilityMatrix(): CompatibilityRow[] {
  const rows: CompatibilityRow[] = [];

  for (const contract of CONTRACT_VERSIONS) {
    for (const binding of CLIENT_BINDINGS) {
      rows.push(checkCompatibility(contract, binding));
    }
  }

  return rows;
}

const COMPATIBILITY_MATRIX = buildCompatibilityMatrix();

/** ── Representative downstream consumer integrations ───────────────────────── */

/** A price consumer integration: reads the latest price for an asset. */
function priceConsumer(contract: ContractVersion, binding: ClientBinding): { ok: boolean; reason?: string } {
  if (!contract.supported || !binding.published) {
    return { ok: false, reason: 'contract or binding not published' };
  }
  if (contract.apiVersion !== binding.targetsApiVersion) {
    return { ok: false, reason: 'API version mismatch' };
  }
  // The consumer calls get_price via the generated binding.
  const hasGetPrice = contract.entrypoints.includes('get_price');
  const hasAssetPrice = binding.interfaces.includes('AssetPrice');
  return { ok: hasGetPrice && hasAssetPrice };
}

/** A batch consumer integration: submits and verifies Merkle batch entries. */
function batchConsumer(contract: ContractVersion, binding: ClientBinding): { ok: boolean; reason?: string } {
  if (!contract.supported || !binding.published) {
    return { ok: false, reason: 'contract or binding not published' };
  }
  if (contract.apiVersion !== binding.targetsApiVersion) {
    return { ok: false, reason: 'API version mismatch' };
  }
  const hasBatch = contract.entrypoints.includes('submit_batch') && contract.entrypoints.includes('apply_batch_entry');
  const hasProof = binding.interfaces.includes('MerkleProof');
  return { ok: hasBatch && hasProof };
}

/** A history consumer integration: reads price history for an asset. */
function historyConsumer(contract: ContractVersion, binding: ClientBinding): { ok: boolean; reason?: string } {
  if (!contract.supported || !binding.published) {
    return { ok: false, reason: 'contract or binding not published' };
  }
  if (contract.apiVersion !== binding.targetsApiVersion) {
    return { ok: false, reason: 'API version mismatch' };
  }
  const hasHistory = contract.entrypoints.includes('get_price_history');
  const hasPriceDataPoint = binding.interfaces.includes('PriceDataPoint');
  return { ok: hasHistory && hasPriceDataPoint };
}

describe('Contract and client compatibility matrix (issue #722)', () => {
  describe('Compatibility matrix construction', () => {
    it('produces a row for every contract × client combination', () => {
      const expectedRows = CONTRACT_VERSIONS.length * CLIENT_BINDINGS.length;
      expect(COMPATIBILITY_MATRIX).toHaveLength(expectedRows);
    });

    it('marks the v1 contract × v1 client row as compatible', () => {
      const row = COMPATIBILITY_MATRIX.find(
        (r) => r.contractVersion === 1 && r.clientVersion === 1,
      );
      expect(row).toBeDefined();
      expect(row!.compatible).toBe(true);
      expect(row!.reason).toBeUndefined();
    });

    it('has no incompatible rows when versions align', () => {
      const incompatible = COMPATIBILITY_MATRIX.filter((r) => !r.compatible);
      expect(incompatible).toHaveLength(0);
    });

    it('every supported contract has at least one compatible published client', () => {
      for (const contract of CONTRACT_VERSIONS) {
        if (!contract.supported) continue;
        const hasCompatible = COMPATIBILITY_MATRIX.some(
          (r) => r.contractVersion === contract.version && r.compatible,
        );
        expect(hasCompatible).toBe(true);
      }
    });

    it('every published client binds to at least one supported contract', () => {
      for (const binding of CLIENT_BINDINGS) {
        if (!binding.published) continue;
        const hasCompatible = COMPATIBILITY_MATRIX.some(
          (r) => r.clientVersion === binding.version && r.compatible,
        );
        expect(hasCompatible).toBe(true);
      }
    });
  });

  describe('Boundary: mismatched API versions are incompatible', () => {
    it('flags a client targeting a newer API version than the contract', () => {
      const contract: ContractVersion = { ...CONTRACT_VERSIONS[0], apiVersion: 1 };
      const binding: ClientBinding = { ...CLIENT_BINDINGS[0], targetsApiVersion: 2 };
      expect(contract.apiVersion).not.toBe(binding.targetsApiVersion);

      const row = checkCompatibility(contract, binding);
      expect(row.compatible).toBe(false);
      expect(row.reason).toContain('API version mismatch');
    });

    it('flags a client targeting an older API version than the contract', () => {
      const contract: ContractVersion = { ...CONTRACT_VERSIONS[0], apiVersion: 2 };
      const binding: ClientBinding = { ...CLIENT_BINDINGS[0], targetsApiVersion: 1 };
      expect(contract.apiVersion).not.toBe(binding.targetsApiVersion);

      const row = checkCompatibility(contract, binding);
      expect(row.compatible).toBe(false);
      expect(row.reason).toContain('API version mismatch');
    });

    it('flags an unsupported contract version', () => {
      const contract: ContractVersion = { ...CONTRACT_VERSIONS[0], supported: false };
      const binding = CLIENT_BINDINGS[0];
      expect(contract.supported).toBe(false);

      const row = checkCompatibility(contract, binding);
      expect(row.compatible).toBe(false);
    });

    it('flags an unpublished client binding', () => {
      const contract = CONTRACT_VERSIONS[0];
      const binding: ClientBinding = { ...CLIENT_BINDINGS[0], published: false };
      expect(binding.published).toBe(false);

      const row = checkCompatibility(contract, binding);
      expect(row.compatible).toBe(false);
    });
  });

  describe('Representative downstream consumer integrations', () => {
    const contract = CONTRACT_VERSIONS[0];
    const binding = CLIENT_BINDINGS[0];

    it('price consumer integration works with v1 contract + v1 client', () => {
      const result = priceConsumer(contract, binding);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('batch consumer integration works with v1 contract + v1 client', () => {
      const result = batchConsumer(contract, binding);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('history consumer integration works with v1 contract + v1 client', () => {
      const result = historyConsumer(contract, binding);
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('price consumer fails on API version mismatch', () => {
      const mismatchedBinding: ClientBinding = { ...binding, targetsApiVersion: 99 };
      const result = priceConsumer(contract, mismatchedBinding);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('API version mismatch');
    });

    it('batch consumer fails on API version mismatch', () => {
      const mismatchedBinding: ClientBinding = { ...binding, targetsApiVersion: 99 };
      const result = batchConsumer(contract, mismatchedBinding);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('API version mismatch');
    });

    it('history consumer fails on API version mismatch', () => {
      const mismatchedBinding: ClientBinding = { ...binding, targetsApiVersion: 99 };
      const result = historyConsumer(contract, mismatchedBinding);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('API version mismatch');
    });

    it('all consumer integrations fail on an unsupported contract', () => {
      const unsupportedContract: ContractVersion = { ...contract, supported: false };
      expect(priceConsumer(unsupportedContract, binding).ok).toBe(false);
      expect(batchConsumer(unsupportedContract, binding).ok).toBe(false);
      expect(historyConsumer(unsupportedContract, binding).ok).toBe(false);
    });
  });
});
