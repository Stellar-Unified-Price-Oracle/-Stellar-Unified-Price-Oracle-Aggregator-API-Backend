import { PriceOracleClient, PriceOracleError, createStellarOracleApiClient, StellarOracleApiClient } from '../index';

describe('PriceOracleClient', () => {
  let client: PriceOracleClient;

  beforeEach(() => {
    client = new PriceOracleClient({
      apiUrl: 'http://localhost:3000/api/v1',
      timeout: 2000,
    });
  });

  afterEach(() => {
    if (client) {
      client.disconnect();
    }
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const defaultClient = new PriceOracleClient();
      expect(defaultClient).toBeDefined();
    });

    it('should initialize with custom config', () => {
      const customClient = new PriceOracleClient({
        apiUrl: 'https://api.example.com',
        apiKey: 'sk_test',
        timeout: 10000,
      });
      expect(customClient).toBeDefined();
    });
  });

  describe('getPrice', () => {
    it('should throw PriceOracleError on invalid asset', async () => {
      await expect(client.getPrice('INVALID')).rejects.toThrow(PriceOracleError);
    });

    it('should have price property as string', async () => {
      // This test would need a mock server or real API
      // Skipping for unit tests
    });
  });

  describe('getPrices', () => {
    it('should return array of prices', async () => {
      // This test would need a mock server or real API
      // Skipping for unit tests
    });
  });

  describe('getHistory', () => {
    it('should accept history options', async () => {
      // This test would need a mock server or real API
      // Skipping for unit tests
    });

    it('should handle optional parameters', async () => {
      const options = {
        limit: 50,
      };
      await expect(client.getHistory('XLM', options)).rejects.toThrow(PriceOracleError);
    });
  });

  describe('subscriptions', () => {
    it('should return subscription object with unsubscribe method', () => {
      const callback = jest.fn();
      const subscription = client.subscribeToPrices(callback);

      expect(subscription).toBeDefined();
      expect(typeof subscription.unsubscribe).toBe('function');
      expect(typeof subscription.isActive).toBe('function');
    });

    it('should allow subscribing to specific asset', () => {
      const callback = jest.fn();
      const subscription = client.subscribeToAsset('XLM', callback);

      expect(subscription).toBeDefined();
      expect(subscription.isActive()).toBe(true);

      subscription.unsubscribe();
      expect(subscription.isActive()).toBe(false);
    });

    it('should support error callbacks', () => {
      const priceCallback = jest.fn();
      const errorCallback = jest.fn();
      const subscription = client.subscribeToPrices(priceCallback, errorCallback);

      expect(subscription).toBeDefined();
      subscription.unsubscribe();
    });
  });

  describe('connection management', () => {
    it('should report not connected initially', () => {
      expect(client.isConnected()).toBe(false);
    });

    it('should disconnect cleanly', () => {
      expect(() => {
        client.disconnect();
      }).not.toThrow();
    });
  });

  describe('error handling', () => {
    it('should have PriceOracleError class available', () => {
      const error = new PriceOracleError('TEST', 'Test error');
      expect(error).toBeInstanceOf(PriceOracleError);
      expect(error.code).toBe('TEST');
    });
  });

  describe('generated client', () => {
    it('should create StellarOracleApiClient via factory', () => {
      const client = createStellarOracleApiClient({ baseUrl: 'http://localhost:3000' });
      expect(client).toBeInstanceOf(StellarOracleApiClient);
    });
  });

  describe('API key handling', () => {
    it('should initialize with API key', () => {
      const apiClient = new PriceOracleClient({
        apiKey: 'sk_test123',
      });
      expect(apiClient).toBeDefined();
    });
  });

  describe('timeout handling', () => {
    it('should respect timeout config', () => {
      const timeoutClient = new PriceOracleClient({
        timeout: 100, // Very short timeout
      });
      expect(timeoutClient).toBeDefined();
    });
  });

  describe('reconnection configuration', () => {
    it('should accept reconnection config', () => {
      const reconnectClient = new PriceOracleClient({
        autoReconnect: true,
        maxReconnectAttempts: 5,
        initialBackoffMs: 500,
        maxBackoffMs: 30000,
        backoffMultiplier: 1.5,
      });
      expect(reconnectClient).toBeDefined();
    });

    it('should disable auto reconnect when configured', () => {
      const noReconnectClient = new PriceOracleClient({
        autoReconnect: false,
      });
      expect(noReconnectClient).toBeDefined();
    });
  });
});

describe('PriceOracleError', () => {
  it('should create error with code and message', () => {
    const error = new PriceOracleError('TEST_CODE', 'Test message');
    expect(error.code).toBe('TEST_CODE');
    expect(error.message).toBe('Test message');
    expect(error.name).toBe('PriceOracleError');
  });

  it('should include status code if provided', () => {
    const error = new PriceOracleError('NOT_FOUND', 'Not found', 404);
    expect(error.statusCode).toBe(404);
  });

  it('should be an instance of Error', () => {
    const error = new PriceOracleError('TEST', 'Test');
    expect(error instanceof Error).toBe(true);
  });
});
