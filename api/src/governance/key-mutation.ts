import type { Request, RequestHandler, Response } from 'express';
import { KeyStoreWriteError } from './api-key-manager';
import { logger } from '../observability/logger';
import {
  KeyInventoryError,
  getKeyInventory,
  type KeyInventoryEntry,
} from './key-inventory';

/**
 * Wrap an API-key mutation handler so a failed key-store write is surfaced as
 * a 500 KEY_STORE_WRITE_FAILED instead of an unhandled rejection. The manager
 * has already rolled the mutation back by the time this sees the error.
 *
 * Before the handler runs, the key inventory is consulted so that mutations
 * against expired or unowned keys are rejected with a clear error, and so that
 * rotations update inventory metadata (rotation timestamp, algorithm, owner).
 */
export function keyMutation(handler: (req: Request, res: Response) => unknown): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve()
      .then(() => {
        const inventory = getKeyInventory();
        const keyId = extractKeyId(req);

        if (keyId) {
          const entry: KeyInventoryEntry | undefined = inventory.get(keyId);

          if (!entry) {
            logger.warn('Rejected mutation against unknown key', { keyId });
            res.status(404).json({
              success: false,
              error: {
                code: 'KEY_NOT_IN_INVENTORY',
                message: 'The referenced key is not present in the key inventory',
              },
            });
            return;
          }

          if (!entry.owner) {
            logger.warn('Rejected mutation against unowned key', { keyId });
            res.status(409).json({
              success: false,
              error: {
                code: 'KEY_UNOWNED',
                message: 'The referenced key has no assigned owner and cannot be mutated',
              },
            });
            return;
          }

          if (inventory.isExpired(keyId)) {
            logger.warn('Rejected mutation against expired key', { keyId });
            res.status(409).json({
              success: false,
              error: {
                code: 'KEY_EXPIRED',
                message: 'The referenced key has expired and cannot be mutated',
              },
            });
            return;
          }
        }

        return Promise.resolve(handler(req, res)).then(() => {
          if (keyId && isRotationRequest(req)) {
            try {
              inventory.recordRotation(keyId, {
                algorithm: extractAlgorithm(req),
                rotatedAt: new Date(),
              });
            } catch (err) {
              logger.error('Failed to record key rotation in inventory', err);
            }
          }
        });
      })
      .catch((err: unknown) => {
        if (err instanceof KeyStoreWriteError) {
          logger.error('API key store write failed; mutation rolled back', err);
          res.status(500).json({
            success: false,
            error: {
              code: 'KEY_STORE_WRITE_FAILED',
              message: 'API key store write failed; the mutation was rolled back and not applied',
            },
          });
          return;
        }
        if (err instanceof KeyInventoryError) {
          logger.error('Key inventory operation failed', err);
          res.status(500).json({
            success: false,
            error: {
              code: 'KEY_INVENTORY_ERROR',
              message: 'Key inventory operation failed; the mutation was not applied',
            },
          });
          return;
        }
        next(err);
      });
  };
}

function extractKeyId(req: Request): string | undefined {
  const fromParams = req.params?.keyId;
  if (typeof fromParams === 'string' && fromParams.length > 0) {
    return fromParams;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.keyId;
  if (typeof fromBody === 'string' && fromBody.length > 0) {
    return fromBody;
  }
  return undefined;
}

function isRotationRequest(req: Request): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  if (body?.rotate === true) {
    return true;
  }
  return typeof req.path === 'string' && /\/rotate\b/.test(req.path);
}

function extractAlgorithm(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const algorithm = body?.algorithm;
  return typeof algorithm === 'string' && algorithm.length > 0 ? algorithm : undefined;
}