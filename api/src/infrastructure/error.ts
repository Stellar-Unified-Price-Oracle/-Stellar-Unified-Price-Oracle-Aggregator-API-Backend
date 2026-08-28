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

export function errorHandler(
  err: Error | ApiError | AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let appError: AppError;

  if (isAppError(err)) {
    appError = err;
  } else if ((err as ApiError).status) {
    appError = new AppError(
      ((err as ApiError).code as ErrorCode) || ErrorCode.INTERNAL_ERROR,
      err.message,
      undefined,
      req.path,
    );
  } else {
    appError = new AppError(ErrorCode.INTERNAL_ERROR, err.message, undefined, req.path);
  }

  logger.error('Request error', {
    code: appError.code,
    status: appError.status,
    message: appError.message,
    path: req.path,
    method: req.method,
    requestId: (req as any).requestId,
  });

  res.status(appError.status).json(appError.toResponseObject());
}

export function notFoundHandler(req: Request, res: Response): void {
  const error = new AppError(
    ErrorCode.NOT_FOUND,
    `Route ${req.method} ${req.path} not found`,
    undefined,
    req.path,
  );
  res.status(error.status).json(error.toResponseObject());
}
