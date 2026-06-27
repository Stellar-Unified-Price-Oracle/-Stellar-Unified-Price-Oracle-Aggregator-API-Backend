export enum ErrorCode {
  // Client errors (4xx)
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  UNPROCESSABLE_ENTITY = 'UNPROCESSABLE_ENTITY',
  RATE_LIMITED = 'RATE_LIMITED',

  // Server errors (5xx)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',

  // Domain-specific errors
  INVALID_ASSET = 'INVALID_ASSET',
  PRICE_NOT_FOUND = 'PRICE_NOT_FOUND',
  PRICE_STALE = 'PRICE_STALE',
  SOURCE_UNHEALTHY = 'SOURCE_UNHEALTHY',
  AGGREGATION_FAILED = 'AGGREGATION_FAILED',
  CONTRACT_ERROR = 'CONTRACT_ERROR',
  INVALID_DECIMALS = 'INVALID_DECIMALS',
  INVALID_TIMESTAMP = 'INVALID_TIMESTAMP',
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

export interface ErrorDetails {
  code: ErrorCode;
  status: number;
  title: string;
  description: string;
  instance?: string;
  type?: string;
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorDetails> = {
  [ErrorCode.BAD_REQUEST]: {
    code: ErrorCode.BAD_REQUEST,
    status: 400,
    title: 'Bad Request',
    description: 'The request is invalid or malformed',
    type: 'https://api.stellar-oracle.com/errors/bad-request',
  },
  [ErrorCode.UNAUTHORIZED]: {
    code: ErrorCode.UNAUTHORIZED,
    status: 401,
    title: 'Unauthorized',
    description: 'Authentication is required but not provided',
    type: 'https://api.stellar-oracle.com/errors/unauthorized',
  },
  [ErrorCode.FORBIDDEN]: {
    code: ErrorCode.FORBIDDEN,
    status: 403,
    title: 'Forbidden',
    description: 'Insufficient permissions to access this resource',
    type: 'https://api.stellar-oracle.com/errors/forbidden',
  },
  [ErrorCode.NOT_FOUND]: {
    code: ErrorCode.NOT_FOUND,
    status: 404,
    title: 'Not Found',
    description: 'The requested resource does not exist',
    type: 'https://api.stellar-oracle.com/errors/not-found',
  },
  [ErrorCode.CONFLICT]: {
    code: ErrorCode.CONFLICT,
    status: 409,
    title: 'Conflict',
    description: 'The request conflicts with existing data',
    type: 'https://api.stellar-oracle.com/errors/conflict',
  },
  [ErrorCode.UNPROCESSABLE_ENTITY]: {
    code: ErrorCode.UNPROCESSABLE_ENTITY,
    status: 422,
    title: 'Unprocessable Entity',
    description: 'The request is well-formed but contains semantic errors',
    type: 'https://api.stellar-oracle.com/errors/unprocessable-entity',
  },
  [ErrorCode.RATE_LIMITED]: {
    code: ErrorCode.RATE_LIMITED,
    status: 429,
    title: 'Too Many Requests',
    description: 'Rate limit exceeded. Please try again later',
    type: 'https://api.stellar-oracle.com/errors/rate-limited',
  },
  [ErrorCode.INTERNAL_ERROR]: {
    code: ErrorCode.INTERNAL_ERROR,
    status: 500,
    title: 'Internal Server Error',
    description: 'An unexpected server error occurred',
    type: 'https://api.stellar-oracle.com/errors/internal-error',
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    code: ErrorCode.SERVICE_UNAVAILABLE,
    status: 503,
    title: 'Service Unavailable',
    description: 'The service is temporarily unavailable',
    type: 'https://api.stellar-oracle.com/errors/service-unavailable',
  },
  [ErrorCode.GATEWAY_TIMEOUT]: {
    code: ErrorCode.GATEWAY_TIMEOUT,
    status: 504,
    title: 'Gateway Timeout',
    description: 'The upstream service did not respond in time',
    type: 'https://api.stellar-oracle.com/errors/gateway-timeout',
  },
  [ErrorCode.INVALID_ASSET]: {
    code: ErrorCode.INVALID_ASSET,
    status: 400,
    title: 'Invalid Asset',
    description: 'The specified asset code is invalid or not supported',
    type: 'https://api.stellar-oracle.com/errors/invalid-asset',
  },
  [ErrorCode.PRICE_NOT_FOUND]: {
    code: ErrorCode.PRICE_NOT_FOUND,
    status: 404,
    title: 'Price Not Found',
    description: 'No price data is available for the requested asset',
    type: 'https://api.stellar-oracle.com/errors/price-not-found',
  },
  [ErrorCode.PRICE_STALE]: {
    code: ErrorCode.PRICE_STALE,
    status: 503,
    title: 'Stale Price Data',
    description: 'The price data is older than the acceptable staleness threshold',
    type: 'https://api.stellar-oracle.com/errors/price-stale',
  },
  [ErrorCode.SOURCE_UNHEALTHY]: {
    code: ErrorCode.SOURCE_UNHEALTHY,
    status: 503,
    title: 'Source Unhealthy',
    description: 'One or more oracle sources are unhealthy',
    type: 'https://api.stellar-oracle.com/errors/source-unhealthy',
  },
  [ErrorCode.AGGREGATION_FAILED]: {
    code: ErrorCode.AGGREGATION_FAILED,
    status: 503,
    title: 'Aggregation Failed',
    description: 'Failed to aggregate price data from oracle sources',
    type: 'https://api.stellar-oracle.com/errors/aggregation-failed',
  },
  [ErrorCode.CONTRACT_ERROR]: {
    code: ErrorCode.CONTRACT_ERROR,
    status: 503,
    title: 'Contract Error',
    description: 'An error occurred while interacting with the Soroban contract',
    type: 'https://api.stellar-oracle.com/errors/contract-error',
  },
  [ErrorCode.INVALID_DECIMALS]: {
    code: ErrorCode.INVALID_DECIMALS,
    status: 400,
    title: 'Invalid Decimals',
    description: 'The price decimals value is invalid',
    type: 'https://api.stellar-oracle.com/errors/invalid-decimals',
  },
  [ErrorCode.INVALID_TIMESTAMP]: {
    code: ErrorCode.INVALID_TIMESTAMP,
    status: 400,
    title: 'Invalid Timestamp',
    description: 'The provided timestamp is invalid or in the future',
    type: 'https://api.stellar-oracle.com/errors/invalid-timestamp',
  },
  [ErrorCode.WEBSOCKET_ERROR]: {
    code: ErrorCode.WEBSOCKET_ERROR,
    status: 400,
    title: 'WebSocket Error',
    description: 'An error occurred in the WebSocket connection',
    type: 'https://api.stellar-oracle.com/errors/websocket-error',
  },
  [ErrorCode.VALIDATION_ERROR]: {
    code: ErrorCode.VALIDATION_ERROR,
    status: 422,
    title: 'Validation Error',
    description: 'One or more validation errors occurred',
    type: 'https://api.stellar-oracle.com/errors/validation-error',
  },
};

export function getErrorDetails(code: ErrorCode, instance?: string): ErrorDetails {
  const details = ERROR_CATALOG[code];
  return instance ? { ...details, instance } : details;
}
