import { ErrorCode, getErrorDetails } from './catalog';

export interface ErrorContext {
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly context?: ErrorContext;
  readonly instance?: string;

  constructor(
    code: ErrorCode,
    message?: string,
    context?: ErrorContext,
    instance?: string,
  ) {
    const details = getErrorDetails(code, instance);
    super(message || details.description);

    this.code = code;
    this.status = details.status;
    this.type = details.type || `https://api.stellar-oracle.com/errors/${code}`;
    this.title = details.title;
    this.context = context;
    this.instance = instance;

    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON() {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.message,
      instance: this.instance,
      ...(this.context && { context: this.context }),
    };
  }

  toResponseObject() {
    return {
      success: false,
      error: this.toJSON(),
      timestamp: new Date().toISOString(),
    };
  }
}

export function createError(
  code: ErrorCode,
  message?: string,
  context?: ErrorContext,
  instance?: string,
): AppError {
  return new AppError(code, message, context, instance);
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
