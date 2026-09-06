import { Request, Response, NextFunction } from 'express';
import { AppError, isAppError } from './app-error';
import { ErrorCode } from './catalog';
import { logger } from '../observability/logger';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorContext {
  path?: string;
  method?: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Normalize any thrown value into an {@link AppError} (issue #299).
 *
 * AppErrors pass through unchanged; ad-hoc `{ status, code, message }` shapes
 * are mapped onto the error catalog; anything else becomes INTERNAL_ERROR.
 * This is the single entry point route handlers and middleware use so every
 * error response is the standardized AppError envelope.
 */
export function toAppError(error: unknown, fallbackPath?: string): AppError {
  if (isAppError(error)) return error;

  if (error && typeof error === 'object' && 'status' in error) {
    const candidate = error as ApiError;
    if (typeof candidate.status === 'number' && typeof candidate.message === 'string') {
      return new AppError(
        (candidate.code as ErrorCode) || ErrorCode.INTERNAL_ERROR,
        candidate.message,
        candidate.details !== undefined ? { details: candidate.details } : undefined,
        fallbackPath,
      );
    }
  }

  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return new AppError(ErrorCode.INTERNAL_ERROR, message, undefined, fallbackPath);
}

/**
 * Log an error with full request context and send the standardized AppError
 * response. Used by the middleware below and by route handlers that want the
 * same envelope (issue #299).
 */
export function sendError(
  res: Response,
  error: unknown,
  context: ErrorContext = {},
): void {
  const appError = toAppError(error, context.path);
  const path = context.path ?? res.req?.path;
  const method = context.method ?? res.req?.method;
  const requestId = context.requestId ?? (res.req as Request).requestId;

  logger.error('Request error', {
    code: appError.code,
    status: appError.status,
    message: appError.message,
    path: req.path,
    method: req.method,
    requestId: req.requestId,
  });

  res.status(appError.status).json(appError.toResponseObject());
}

/**
 * Send an explicit domain error with the standardized envelope
 * `{ success: false, error: { code, message } }` and log it with request
 * context (issue #299). Use this for intentional 4xx/5xx responses in route
 * handlers; use {@link sendError} for unexpected/uncaught errors.
 */
export function sendErrorResponse(
  res: Response,
  status: number,
  code: string,
  message: string,
  context: ErrorContext = {},
): void {
  const path = context.path ?? res.req?.path;
  const method = context.method ?? res.req?.method;
  const requestId = context.requestId ?? (res.req as Request).requestId;

  logger.error('Request error', {
    code,
    status,
    message,
    path,
    method,
    requestId,
    ...context,
  });

  res.status(status).json({ success: false, error: { code, message } });
}

export function errorHandler(
  err: Error | ApiError | AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  sendError(res, err, { path: req.path, method: req.method, requestId: req.requestId });
}

export function notFoundHandler(req: Request, res: Response): void {
  const error = new AppError(
    ErrorCode.NOT_FOUND,
    `Route ${req.method} ${req.path} not found`,
    undefined,
    req.path,
  );
  sendError(res, error, { path: req.path, method: req.method, requestId: req.requestId });
}
