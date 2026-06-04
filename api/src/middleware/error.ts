import { Request, Response, NextFunction } from 'express';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export function errorHandler(
  err: Error | ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = (err as ApiError).status || 500;
  const code = (err as ApiError).code || 'INTERNAL_ERROR';
  const message = err.message || 'An unexpected error occurred';

  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: Math.floor(Date.now() / 1000),
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Resource not found' },
    timestamp: Math.floor(Date.now() / 1000),
  });
}
