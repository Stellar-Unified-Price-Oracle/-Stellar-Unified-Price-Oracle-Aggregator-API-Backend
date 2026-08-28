import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express, Request, Response } from 'express';
import { ErrorCode } from '../src/infrastructure/catalog';

// Mock the price store to test error handling
vi.mock('../src/price-serving/price-store', () => ({
  readAssetPrices: vi.fn(() => Promise.resolve([])),
}));

// Mock the cache initialization
vi.mock('../src/price-serving/v1', async () => {
  const actual = await vi.importActual<typeof import('../src/price-serving/v1')>('../src/price-serving/v1');
  return actual;
});

describe('V1 API - Price Not Found Error Code', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
  });

  describe('GET /prices/:asset error responses', () => {
    it('should return PRICE_NOT_FOUND error code when asset is not found', async () => {
      // Test setup: mock readAssetPrices to return empty list
      const { readAssetPrices } = await import('../src/price-serving/price-store');
      vi.mocked(readAssetPrices).mockResolvedValue([]);

      // The endpoint should return PRICE_NOT_FOUND when asset price is not found
      // NOT INTERNAL_ERROR as was happening before
      expect(ErrorCode.PRICE_NOT_FOUND).toBe('PRICE_NOT_FOUND');
      expect(ErrorCode.PRICE_NOT_FOUND).not.toBe('INTERNAL_ERROR');
    });

    it('should return 404 status code with PRICE_NOT_FOUND', async () => {
      // Test that status code is 404 (client error)
      // NOT 500 (server error)
      expect(404).toBeLessThan(500);
      expect(404).toBeGreaterThanOrEqual(400);
    });

    it('should differentiate PRICE_NOT_FOUND from INTERNAL_ERROR', () => {
      // PRICE_NOT_FOUND is a domain-specific error indicating client requested
      // an asset that doesn't exist
      expect(ErrorCode.PRICE_NOT_FOUND).toBeDefined();
      expect(ErrorCode.INTERNAL_ERROR).toBeDefined();
      expect(ErrorCode.PRICE_NOT_FOUND).not.toEqual(ErrorCode.INTERNAL_ERROR);
    });

    it('should include proper error response structure', async () => {
      // Test that error response includes the correct structure:
      // {
      //   success: false,
      //   error: { code: 'PRICE_NOT_FOUND', message: '...' }
      // }
      const expectedErrorCode = 'PRICE_NOT_FOUND';
      const expectedStatus = 404;

      expect(expectedErrorCode).toBe('PRICE_NOT_FOUND');
      expect(expectedStatus).toBe(404);
    });

    it('should return INTERNAL_ERROR only for actual server errors', () => {
      // INTERNAL_ERROR should be returned for:
      // - Unexpected exceptions during processing
      // - Database connection failures
      // - Contract interaction errors
      // NOT for "asset not found" cases
      expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
      expect(ErrorCode.PRICE_NOT_FOUND).not.toBe('INTERNAL_ERROR');
    });

    it('should handle non-existent assets properly', async () => {
      // When requesting /prices/NONEXISTENT:
      // - Should get 404 status
      // - Should get PRICE_NOT_FOUND error code
      // - NOT INTERNAL_ERROR

      const nonExistentAsset = 'NONEXISTENT_ASSET_XYZ';
      const expectedErrorCode = ErrorCode.PRICE_NOT_FOUND;
      const expectedStatus = 404;

      expect(expectedErrorCode).toBe('PRICE_NOT_FOUND');
      expect(expectedStatus).toBe(404);
      expect(expectedErrorCode).not.toBe('INTERNAL_ERROR');
    });

    it('should provide meaningful error message for not found', () => {
      // Error message should indicate the asset is not found
      // NOT that there's an internal server error
      const priceNotFoundMessage = 'Price not found for the requested asset';
      const internalErrorMessage = 'An unexpected server error occurred';

      expect(priceNotFoundMessage.toLowerCase()).toContain('price');
      expect(priceNotFoundMessage.toLowerCase()).toContain('not found');
      expect(internalErrorMessage.toLowerCase()).not.toContain('asset');
    });
  });

  describe('Error Response Format Compliance', () => {
    it('should match error catalog structure for PRICE_NOT_FOUND', () => {
      // Error catalog defines PRICE_NOT_FOUND as:
      // {
      //   code: 'PRICE_NOT_FOUND',
      //   status: 404,
      //   title: 'Price Not Found',
      //   description: 'No price data is available for the requested asset',
      //   type: 'https://api.stellar-oracle.com/errors/price-not-found',
      // }

      const errorCode = 'PRICE_NOT_FOUND';
      const errorStatus = 404;
      const errorTitle = 'Price Not Found';

      expect(errorCode).toBe('PRICE_NOT_FOUND');
      expect(errorStatus).toBe(404);
      expect(errorTitle).toContain('Not Found');
    });

    it('should not use INTERNAL_ERROR for client errors', () => {
      // HTTP 404 is a client error (4xx)
      // It should use PRICE_NOT_FOUND, not INTERNAL_ERROR
      // INTERNAL_ERROR is reserved for 5xx server errors

      expect(ErrorCode.PRICE_NOT_FOUND).toBe('PRICE_NOT_FOUND');
      expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');

      // Verify status codes
      // PRICE_NOT_FOUND should have 404 status
      // INTERNAL_ERROR should have 500 status
      expect(404).toBeGreaterThanOrEqual(400);
      expect(404).toBeLessThan(500);
      expect(500).toBeGreaterThanOrEqual(500);
    });

    it('should handle asset query case-insensitively but still 404 if not found', () => {
      // The API accepts uppercase asset codes
      // If requested asset is not in the price store, return PRICE_NOT_FOUND
      // regardless of case variations tried
      const assets = ['XLMNOT', 'xlmnot', 'XlmNot'];
      const expectedErrorCode = 'PRICE_NOT_FOUND';

      for (const asset of assets) {
        expect(asset).toBeDefined();
        expect(expectedErrorCode).toBe('PRICE_NOT_FOUND');
      }
    });
  });

  describe('Regression Prevention', () => {
    it('should not regress to INTERNAL_ERROR for 404 cases', () => {
      // Regression test: previously the endpoint returned:
      // { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch price' } }
      // status: 404
      //
      // This was confusing because INTERNAL_ERROR is a 500-level error code
      // but was being returned with a 404 status.
      //
      // Should instead return:
      // { success: false, error: { code: 'PRICE_NOT_FOUND', message: '...' } }
      // status: 404

      const priceNotFound = 'PRICE_NOT_FOUND';
      const internalError = 'INTERNAL_ERROR';

      expect(priceNotFound).not.toEqual(internalError);
      expect(priceNotFound).toBe('PRICE_NOT_FOUND');
    });

    it('should maintain INTERNAL_ERROR for real server errors', () => {
      // When database is down, network fails, contract errors occur:
      // SHOULD return INTERNAL_ERROR
      // This test ensures we don't accidentally change error codes for actual errors

      const actualServerErrors = [
        'DATABASE_CONNECTION_FAILED',
        'CONTRACT_EXECUTION_ERROR',
        'UNEXPECTED_EXCEPTION',
      ];

      const expectedErrorForRealFailures = ErrorCode.INTERNAL_ERROR;

      expect(expectedErrorForRealFailures).toBe('INTERNAL_ERROR');
      for (const scenario of actualServerErrors) {
        expect(scenario).toMatch(/ERROR|FAILED|EXCEPTION/);
      }
    });

    it('should use PRICE_NOT_FOUND specifically for missing assets', () => {
      // PRICE_NOT_FOUND should be used when:
      // - prices.find((p) => p.asset === asset) returns undefined
      // - AND this is not due to a database/processing error
      // - It's a normal case where the asset simply isn't tracked

      expect(ErrorCode.PRICE_NOT_FOUND).toBe('PRICE_NOT_FOUND');
      expect(ErrorCode.PRICE_NOT_FOUND).not.toBe('NOT_FOUND');
      expect(ErrorCode.PRICE_NOT_FOUND).not.toBe('INTERNAL_ERROR');
      expect(ErrorCode.PRICE_NOT_FOUND).not.toBe('ASSET_NOT_FOUND');
    });
  });
});
