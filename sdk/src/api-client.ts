import { StellarOracleApiClient } from './generated';

export type CreateApiClientOptions = {
  baseUrl?: string;
  apiKey?: string;
};

export function createStellarOracleApiClient(options: CreateApiClientOptions = {}): StellarOracleApiClient {
  const baseUrl = options.baseUrl ?? 'http://localhost:3000';
  return new StellarOracleApiClient({
    BASE: baseUrl,
    TOKEN: options.apiKey,
  });
}
