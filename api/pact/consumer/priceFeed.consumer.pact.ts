/**
 * Consumer-side Pact contract test for the Price Feed API.
 *
 * This test defines the contract from the perspective of a consumer
 * (e.g. a dashboard or trading bot) that calls GET /v1/prices/:asset.
 * The resulting pact file is shared with the provider to verify.
 *
 * Run:
 *   npm run pact:consumer
 */

import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';

const { like, string, number, timestamp } = MatchersV3;

const provider = new PactV3({
  consumer: 'PriceFeedDashboard',
  provider: 'StellarPriceOracleAPI',
  dir: path.resolve(__dirname, '../../pact/pacts'),
  logLevel: 'warn',
});

describe('Price Feed API — consumer contract', () => {
  describe('GET /v1/prices/:asset', () => {
    it('returns the latest price for XLM_USD', async () => {
      await provider
        .given('a price record exists for XLM_USD')
        .uponReceiving('a request for the latest XLM_USD price')
        .withRequest({
          method: 'GET',
          path: '/v1/prices/XLM_USD',
          headers: { Accept: 'application/json' },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            pair: string('XLM_USD'),
            price: string('0.12345678'),
            source: string('band_protocol'),
            fetchedAt: number(1720000000000),
            confidence: number(0.98),
          },
        })
        .executeTest(async (mockserver) => {
          const res = await fetch(`${mockserver.url}/v1/prices/XLM_USD`, {
            headers: { Accept: 'application/json' },
          });

          expect(res.status).toBe(200);
          const body = await res.json() as Record<string, unknown>;
          expect(body).toHaveProperty('pair', 'XLM_USD');
          expect(typeof body['price']).toBe('string');
          expect(typeof body['fetchedAt']).toBe('number');
        });
    });

    it('returns 404 when no price exists for the requested pair', async () => {
      await provider
        .given('no price record exists for UNKNOWN_PAIR')
        .uponReceiving('a request for a non-existent asset pair')
        .withRequest({
          method: 'GET',
          path: '/v1/prices/UNKNOWN_PAIR',
          headers: { Accept: 'application/json' },
        })
        .willRespondWith({
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: like({ error: string('Price not found') }),
        })
        .executeTest(async (mockserver) => {
          const res = await fetch(`${mockserver.url}/v1/prices/UNKNOWN_PAIR`, {
            headers: { Accept: 'application/json' },
          });
          expect(res.status).toBe(404);
        });
    });
  });

  describe('GET /v1/prices/:asset/history', () => {
    it('returns a list of historical price ticks', async () => {
      await provider
        .given('historical price records exist for XLM_USD')
        .uponReceiving('a request for XLM_USD price history')
        .withRequest({
          method: 'GET',
          path: '/v1/prices/XLM_USD/history',
          query: { limit: '5' },
          headers: { Accept: 'application/json' },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            data: like([
              {
                pair: string('XLM_USD'),
                price: string('0.12345678'),
                source: string('band_protocol'),
                fetchedAt: number(1720000000000),
                confidence: number(0.98),
              },
            ]),
          },
        })
        .executeTest(async (mockserver) => {
          const res = await fetch(
            `${mockserver.url}/v1/prices/XLM_USD/history?limit=5`,
            { headers: { Accept: 'application/json' } }
          );
          expect(res.status).toBe(200);
          const body = await res.json() as { data: unknown[] };
          expect(Array.isArray(body.data)).toBe(true);
        });
    });
  });
});
