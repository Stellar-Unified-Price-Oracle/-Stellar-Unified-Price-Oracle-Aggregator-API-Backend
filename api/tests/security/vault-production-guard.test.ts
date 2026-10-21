import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultClient } from '@stellar-oracle/vault-client';

describe('Vault production fail-closed guard', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('refuses to construct without VAULT_ADDR', () => {
    expect(() => new VaultClient()).toThrow(/VAULT_ADDR is required in production/);
  });

  it('refuses to construct without VAULT_TOKEN even when an address is set', () => {
    process.env.VAULT_ADDR = 'https://vault.internal:8200';
    expect(() => new VaultClient()).toThrow(/VAULT_TOKEN is required in production/);
  });

  it('refuses development placeholder tokens in production', () => {
    process.env.VAULT_ADDR = 'https://vault.internal:8200';
    process.env.VAULT_TOKEN = 'dev-root-super-secret-token';
    expect(() => new VaultClient()).toThrow(/development Vault token/);
  });

  it('accepts an explicitly configured production Vault', () => {
    expect(
      () => new VaultClient({ url: 'https://vault.internal:8200', token: 's.real-production-token' }),
    ).not.toThrow();
  });

  it('keeps the local fallback outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(() => new VaultClient()).not.toThrow();
  });
});
