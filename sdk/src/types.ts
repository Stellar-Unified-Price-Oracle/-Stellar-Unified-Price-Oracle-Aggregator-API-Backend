/**
 * Price data point returned by the API
 */
export interface PriceData {
  asset: string;
  price: string;
  decimals: number;
  sources: string[];
  timestamp: number;
  confidence: number;
  cached?: boolean;
}

/**
 * Aggregated prices response
 */
export interface PricesResponse {
  success: boolean;
  data: {
    timestamp: number;
    count: number;
    prices: PriceData[];
  };
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Single price response
 */
export interface PriceResponse {
  success: boolean;
  data: PriceData;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Price history entry
 */
export interface HistoryEntry {
  asset: string;
  price: string;
  decimals: number;
  timestamp: number;
  source: string;
}

/**
 * Price history response
 */
export interface HistoryResponse {
  success: boolean;
  data: {
    asset: string;
    from: number | null;
    to: number | null;
    count: number;
    prices: HistoryEntry[];
  };
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Historical query options
 */
export interface HistoryOptions {
  from?: number;
  to?: number;
  limit?: number;
}

/**
 * WebSocket message types
 */
export type WSMessageType = 'price_update' | 'error' | 'subscribe' | 'unsubscribe';

/**
 * WebSocket message
 */
export interface WSMessage {
  type: WSMessageType;
  data?: PriceData[] | Error;
  error?: string;
}

/**
 * SDK client configuration
 */
export interface ClientConfig {
  apiUrl?: string;
  wsUrl?: string;
  apiKey?: string;
  timeout?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
}

/**
 * Price subscription callback
 */
export type PriceUpdateCallback = (prices: PriceData[]) => void;

/**
 * Error callback
 */
export type ErrorCallback = (error: Error) => void;

/**
 * Subscription object
 */
export interface Subscription {
  unsubscribe(): void;
  isActive(): boolean;
}

/**
 * Price Oracle API error
 */
export class PriceOracleError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = 'PriceOracleError';
  }
}
