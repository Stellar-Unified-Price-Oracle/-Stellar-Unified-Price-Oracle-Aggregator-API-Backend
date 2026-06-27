import {
  ClientConfig,
  PriceData,
  PricesResponse,
  PriceResponse,
  HistoryResponse,
  HistoryOptions,
  WSMessage,
  PriceUpdateCallback,
  ErrorCallback,
  Subscription,
  PriceOracleError,
} from './types';

/**
 * Stellar Price Oracle Client SDK
 * Provides methods to fetch and subscribe to price data
 */
export class PriceOracleClient {
  private apiUrl: string;
  private wsUrl: string;
  private apiKey?: string;
  private timeout: number;
  private autoReconnect: boolean;
  private maxReconnectAttempts: number;
  private initialBackoffMs: number;
  private maxBackoffMs: number;
  private backoffMultiplier: number;

  private ws: WebSocket | null = null;
  private wsConnected = false;
  private wsReconnectAttempts = 0;
  private wsReconnectTimeout: NodeJS.Timeout | null = null;
  private wsSubscriptions: Map<string, PriceUpdateCallback[]> = new Map();
  private wsErrorCallbacks: Set<ErrorCallback> = new Set();

  constructor(config: ClientConfig = {}) {
    // Default values
    this.apiUrl = config.apiUrl || 'http://localhost:3000/api/v1';
    this.wsUrl = config.wsUrl || 'ws://localhost:3001';
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 5000;
    this.autoReconnect = config.autoReconnect !== false;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;
    this.initialBackoffMs = config.initialBackoffMs || 1000;
    this.maxBackoffMs = config.maxBackoffMs || 60000;
    this.backoffMultiplier = config.backoffMultiplier || 2;
  }

  /**
   * Get all current prices
   */
  async getPrices(): Promise<PriceData[]> {
    const response = await this.makeRequest<PricesResponse>('/prices');
    if (!response.success) {
      throw new PriceOracleError(response.error?.code || 'UNKNOWN', response.error?.message || 'Failed to fetch prices');
    }
    return response.data.prices;
  }

  /**
   * Get price for a specific asset
   */
  async getPrice(asset: string): Promise<PriceData> {
    const response = await this.makeRequest<PriceResponse>(`/prices/${asset}`);
    if (!response.success) {
      throw new PriceOracleError(response.error?.code || 'UNKNOWN', response.error?.message || `Failed to fetch ${asset} price`);
    }
    return response.data;
  }

  /**
   * Get price history for an asset
   */
  async getHistory(asset: string, options?: HistoryOptions): Promise<HistoryResponse> {
    const params = new URLSearchParams();
    if (options?.from) params.append('from', options.from.toString());
    if (options?.to) params.append('to', options.to.toString());
    if (options?.limit) params.append('limit', options.limit.toString());

    const queryString = params.toString();
    const url = `/history/${asset}${queryString ? '?' + queryString : ''}`;
    const response = await this.makeRequest<HistoryResponse>(url);

    if (!response.success) {
      throw new PriceOracleError(response.error?.code || 'UNKNOWN', response.error?.message || `Failed to fetch ${asset} history`);
    }
    return response;
  }

  /**
   * Subscribe to real-time price updates via WebSocket
   */
  subscribeToPrices(callback: PriceUpdateCallback, errorCallback?: ErrorCallback): Subscription {
    if (!this.ws) {
      this.connectWebSocket();
    }

    // Add callbacks to subscription maps
    if (!this.wsSubscriptions.has('all')) {
      this.wsSubscriptions.set('all', []);
    }
    this.wsSubscriptions.get('all')!.push(callback);

    if (errorCallback) {
      this.wsErrorCallbacks.add(errorCallback);
    }

    // Return unsubscribe function
    return {
      unsubscribe: () => {
        const callbacks = this.wsSubscriptions.get('all');
        if (callbacks) {
          const index = callbacks.indexOf(callback);
          if (index > -1) {
            callbacks.splice(index, 1);
          }
        }
        if (errorCallback) {
          this.wsErrorCallbacks.delete(errorCallback);
        }
      },
      isActive: () => {
        const callbacks = this.wsSubscriptions.get('all');
        return callbacks ? callbacks.includes(callback) : false;
      },
    };
  }

  /**
   * Subscribe to specific asset price updates
   */
  subscribeToAsset(asset: string, callback: PriceUpdateCallback, errorCallback?: ErrorCallback): Subscription {
    if (!this.ws) {
      this.connectWebSocket();
    }

    const key = `asset:${asset.toUpperCase()}`;
    if (!this.wsSubscriptions.has(key)) {
      this.wsSubscriptions.set(key, []);
    }
    this.wsSubscriptions.get(key)!.push(callback);

    if (errorCallback) {
      this.wsErrorCallbacks.add(errorCallback);
    }

    return {
      unsubscribe: () => {
        const callbacks = this.wsSubscriptions.get(key);
        if (callbacks) {
          const index = callbacks.indexOf(callback);
          if (index > -1) {
            callbacks.splice(index, 1);
          }
        }
        if (errorCallback) {
          this.wsErrorCallbacks.delete(errorCallback);
        }
      },
      isActive: () => {
        const callbacks = this.wsSubscriptions.get(key);
        return callbacks ? callbacks.includes(callback) : false;
      },
    };
  }

  /**
   * Disconnect WebSocket and cleanup
   */
  disconnect(): void {
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = null;
    }

    if (this.ws) {
      this.autoReconnect = false;
      this.ws.close();
      this.ws = null;
      this.wsConnected = false;
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.wsConnected;
  }

  /**
   * Make HTTP request
   */
  private async makeRequest<T>(endpoint: string): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch {
          errorData = { error: { code: 'HTTP_ERROR', message: response.statusText } };
        }

        throw new PriceOracleError(
          errorData.error?.code || 'HTTP_ERROR',
          errorData.error?.message || `HTTP ${response.status}`,
          response.status,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof PriceOracleError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new PriceOracleError('TIMEOUT', 'Request timeout');
        }
        throw new PriceOracleError('NETWORK_ERROR', error.message);
      }

      throw new PriceOracleError('UNKNOWN', 'An unknown error occurred');
    }
  }

  /**
   * Connect to WebSocket server
   */
  private connectWebSocket(): void {
    if (this.ws) return;

    try {
      // Check if running in Node.js or browser
      const isNode = typeof globalThis !== 'undefined' && (globalThis as any).global !== undefined && (globalThis as any).process !== undefined;

      if (isNode) {
        // Node.js environment
        try {
          const WebSocketLib = require('ws');
          this.ws = new WebSocketLib(this.wsUrl) as WebSocket;
        } catch {
          throw new Error('WebSocket not available. Install "ws" package for Node.js support.');
        }
      } else {
        // Browser environment
        const WS = (globalThis as any).WebSocket || WebSocket;
        this.ws = new WS(this.wsUrl) as WebSocket;
      }

      this.setupWebSocketHandlers();
    } catch (error) {
      this.notifyError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      this.wsConnected = true;
      this.wsReconnectAttempts = 0;
      console.log('[PriceOracleClient] WebSocket connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        this.handleWSMessage(message);
      } catch (error) {
        this.notifyError(new PriceOracleError('WS_PARSE_ERROR', 'Failed to parse WebSocket message'));
      }
    };

    this.ws.onerror = (event) => {
      this.notifyError(new PriceOracleError('WS_ERROR', 'WebSocket error'));
    };

    this.ws.onclose = () => {
      this.wsConnected = false;
      console.log('[PriceOracleClient] WebSocket disconnected');

      if (this.autoReconnect && this.wsReconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      }
    };
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleWSMessage(message: WSMessage): void {
    if (message.type === 'price_update' && message.data) {
      const prices = message.data as PriceData[];

      // Notify all subscribers
      const allCallbacks = this.wsSubscriptions.get('all') || [];
      for (const callback of allCallbacks) {
        callback(prices);
      }

      // Notify asset-specific subscribers
      for (const price of prices) {
        const assetKey = `asset:${price.asset}`;
        const assetCallbacks = this.wsSubscriptions.get(assetKey) || [];
        for (const callback of assetCallbacks) {
          callback([price]);
        }
      }
    } else if (message.type === 'error') {
      this.notifyError(new PriceOracleError('WS_MESSAGE_ERROR', message.error || 'Unknown error'));
    }
  }

  /**
   * Schedule WebSocket reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
    }

    const backoffMs = Math.min(
      this.initialBackoffMs * Math.pow(this.backoffMultiplier, this.wsReconnectAttempts),
      this.maxBackoffMs,
    );

    this.wsReconnectAttempts++;

    console.log(`[PriceOracleClient] Reconnecting in ${backoffMs}ms (attempt ${this.wsReconnectAttempts}/${this.maxReconnectAttempts})`);

    this.wsReconnectTimeout = setTimeout(() => {
      this.wsReconnectTimeout = null;
      this.ws = null;
      this.connectWebSocket();
    }, backoffMs);
  }

  /**
   * Notify error callbacks
   */
  private notifyError(error: Error): void {
    for (const callback of this.wsErrorCallbacks) {
      callback(error);
    }
  }
}
