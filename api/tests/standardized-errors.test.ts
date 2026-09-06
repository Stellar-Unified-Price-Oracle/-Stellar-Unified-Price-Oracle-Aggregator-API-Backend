import { describe, it, expect } from 'vitest';
import express, { Express, Request, Response } from 'express';
import request from 'supertest';
import { AppError } from '../src/infrastructure/app-error';
import { ErrorCode } from '../src/infrastructure/catalog';
import { toAppError, sendError, sendErrorResponse, errorHandler, notFoundHandler } from '../src/infrastructure/error';

describe('Standardized error handling (issue #299)', () => {
  describe('toAppError', () => {
    it('passes AppError instances through unchanged', () => {
      const appError = new AppError(ErrorCode.PRICE_NOT_FOUND, 'custom message');
      expect(toAppError(appError)).toBe(appError);
    });

    it('maps ad-hoc ApiError shapes onto the catalog', () => {
      const mapped = toAppError({ status: 404, code: 'PRICE_NOT_FOUND', message: 'nope' });
      expect(mapped).toBeInstanceOf(AppError);
      expect(mapped.code).toBe(ErrorCode.PRICE_NOT_FOUND);
      expect(mapped.status).toBe(404);
    });

    it('normalizes unknown values to INTERNAL_ERROR', () => {
      const mapped = toAppError('something broke');
      expect(mapped).toBeInstanceOf(AppError);
      expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(mapped.message).toBe('something broke');
    });

    it('normalizes Error instances to INTERNAL_ERROR with their message', () => {
      const mapped = toAppError(new Error('db down'));
      expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(mapped.message).toBe('db down');
    });
  });

  describe('sendError middleware', () => {
    it('returns the standard AppError envelope for unknown errors', async () => {
      const app: Express = express();
      app.get('/boom', () => { throw new Error('kaboom'); });
      app.use(errorHandler);

      const res = await request(app).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('kaboom');
      expect(res.body.error.status).toBe(500);
    });

    it('passes AppError status and code through', async () => {
      const app: Express = express();
      app.get('/missing', () => { throw new AppError(ErrorCode.PRICE_NOT_FOUND, 'No price'); });
      app.use(errorHandler);

      const res = await request(app).get('/missing');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PRICE_NOT_FOUND');
      expect(res.body.error.message).toBe('No price');
    });
  });

  describe('notFoundHandler', () => {
    it('returns a NOT_FOUND envelope for unknown routes', async () => {
      const app: Express = express();
      app.use(notFoundHandler);

      const res = await request(app).get('/no-such-route');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('sendError / sendErrorResponse helpers', () => {
    it('sendErrorResponse writes the { code, message } envelope', async () => {
      const app: Express = express();
      app.get('/denied', (_req: Request, res: Response) => {
        sendErrorResponse(res, 403, 'FORBIDDEN', 'Access denied');
      });
      app.use(errorHandler);

      const res = await request(app).get('/denied');
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe('Access denied');
    });

    it('sendError writes the AppError envelope', async () => {
      const app: Express = express();
      app.get('/conflict', (_req: Request, res: Response) => {
        sendError(res, new AppError(ErrorCode.CONFLICT, 'Already exists'));
      });
      app.use(errorHandler);

      const res = await request(app).get('/conflict');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toBe('Already exists');
    });
  });
});
