import { describe, it, expect } from 'vitest';
import {
  formatCanonicalAssetId,
  isCanonicalAssetId,
  networkFromPassphrase,
  normalizeNetwork,
  parseCanonicalAssetId,
  resolveAssetAlias,
} from '../../src/feeds/asset-identity';

const ISSUER_A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ISSUER_B = 'GBBDK7WJVXH5XKXYMZ4XWJHZLJ3YWHM4U4M7YF3DGFHIRYEJYY3A7SCD';

const REGISTRY = [
  { alias: 'USDC', canonicalId: `public:USDC:${ISSUER_A}` },
  { alias: 'USD', canonicalId: `public:USDC:${ISSUER_A}` },
  { alias: 'USDC-TEST', canonicalId: `testnet:USDC:${ISSUER_B}` },
];

describe('canonical asset identity (#671)', () => {
  it('parses and formats a canonical id with issuer and network', () => {
    const parsed = parseCanonicalAssetId(`public:USDC:${ISSUER_A}`);
    expect(parsed).toEqual({ network: 'public', code: 'USDC', issuer: ISSUER_A });
    expect(formatCanonicalAssetId(parsed!)).toBe(`public:USDC:${ISSUER_A}`);
  });

  it('parses the native asset without an issuer', () => {
    const parsed = parseCanonicalAssetId('public:XLM:native');
    expect(parsed).toEqual({ network: 'public', code: 'XLM', issuer: null });
  });

  it('rejects canonical ids that are missing a network or issuer', () => {
    expect(parseCanonicalAssetId(`USDC:${ISSUER_A}`)).toBeNull();
    expect(parseCanonicalAssetId('public:USDC')).toBeNull();
    expect(parseCanonicalAssetId('public:USDC:NOTANISSUER')).toBeNull();
  });

  it('rejects an issuer on the native asset and a missing issuer on other assets', () => {
    expect(parseCanonicalAssetId(`public:XLM:${ISSUER_A}`)).toBeNull();
    expect(parseCanonicalAssetId('public:USD:native')).toBeNull();
  });

  it('rejects malformed issuers and out-of-range asset codes', () => {
    expect(parseCanonicalAssetId('public:USDC:G123')).toBeNull();
    expect(parseCanonicalAssetId('public:TOOLONGCODEXX:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')).toBeNull();
  });

  it('maps network passphrases onto network names and rejects unknown ones', () => {
    expect(networkFromPassphrase('Public Global Stellar Network ; September 2015')).toBe('public');
    expect(networkFromPassphrase('Test SDF Network ; September 2015')).toBe('testnet');
    expect(networkFromPassphrase('Test SDF Future Network ; October 2022')).toBe('futurenet');
    expect(networkFromPassphrase('Local Sandbox Stellar Network ; 2020')).toBe('local');
    expect(networkFromPassphrase('Something Else')).toBeNull();
  });

  it('normalises network aliases', () => {
    expect(normalizeNetwork('Mainnet')).toBe('public');
    expect(normalizeNetwork('public')).toBe('public');
    expect(normalizeNetwork('nonsense')).toBeNull();
  });

  it('recognises canonical ids', () => {
    expect(isCanonicalAssetId(`public:USDC:${ISSUER_A}`)).toBe(true);
    expect(isCanonicalAssetId('USDC')).toBe(false);
  });
});

describe('alias resolution (#671)', () => {
  it('resolves a canonical id unchanged', () => {
    const result = resolveAssetAlias(`public:USDC:${ISSUER_A}`, REGISTRY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonicalId).toBe(`public:USDC:${ISSUER_A}`);
      expect(result.resolution).toBe('canonical');
    }
  });

  it('resolves code and issuer in either order', () => {
    const first = resolveAssetAlias(`USDC:${ISSUER_A}`, REGISTRY);
    const second = resolveAssetAlias(`${ISSUER_A}:USDC`, REGISTRY);
    expect(first.ok && first.canonicalId).toBe(`public:USDC:${ISSUER_A}`);
    expect(second.ok && second.canonicalId).toBe(`public:USDC:${ISSUER_A}`);
  });

  it('resolves a bare code through the registry', () => {
    const result = resolveAssetAlias('usdc', REGISTRY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonicalId).toBe(`public:USDC:${ISSUER_A}`);
      expect(result.resolution).toBe('registry');
    }
  });

  it('resolves the native asset without a registry entry', () => {
    const result = resolveAssetAlias('XLM', REGISTRY, { defaultNetwork: 'testnet' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonicalId).toBe('testnet:XLM:native');
      expect(result.resolution).toBe('native');
    }
  });

  it('resolves a network-qualified native asset', () => {
    const result = resolveAssetAlias('public:XLM', REGISTRY);
    expect(result.ok && result.canonicalId).toBe('public:XLM:native');
  });

  it('reports ambiguity when a code matches several issuers', () => {
    const registry = [
      { alias: 'USDC', canonicalId: `public:USDC:${ISSUER_A}` },
      { alias: 'USDC', canonicalId: `testnet:USDC:${ISSUER_B}` },
    ];
    const result = resolveAssetAlias('USDC', registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('AMBIGUOUS');
      expect(result.candidates).toEqual([`public:USDC:${ISSUER_A}`, `testnet:USDC:${ISSUER_B}`]);
    }
  });

  it('reports ambiguity when two issuers are given without a code', () => {
    const result = resolveAssetAlias(`${ISSUER_A}:${ISSUER_B}`, REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('AMBIGUOUS');
  });

  it('reports an unknown code as not found', () => {
    const result = resolveAssetAlias('DOGE', REGISTRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_FOUND');
  });

  it('rejects an empty alias and an issuer-less non-native code', () => {
    const empty = resolveAssetAlias('   ', REGISTRY);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('INVALID_ALIAS');

    const noIssuer = resolveAssetAlias('public:USDC', REGISTRY);
    expect(noIssuer.ok).toBe(false);
    if (!noIssuer.ok) expect(noIssuer.reason).toBe('INVALID_ALIAS');
  });

  it('rejects an alias that resolves to an invalid canonical id', () => {
    const result = resolveAssetAlias('BROKEN', [{ alias: 'BROKEN', canonicalId: 'not-a-canonical-id' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_ALIAS');
  });
});
