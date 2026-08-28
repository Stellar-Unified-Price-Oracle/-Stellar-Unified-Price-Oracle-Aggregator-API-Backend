import zlib from 'zlib';
import { Request, Response, NextFunction } from 'express';
import { config } from './config';

interface CompressionOptions {
  threshold: number;
  level: number;
}

function pickEncoding(acceptEncoding: string): 'br' | 'gzip' | null {
  const header = acceptEncoding.toLowerCase();
  if (header.includes('br')) return 'br';
  if (header.includes('gzip')) return 'gzip';
  return null;
}

/**
 * Negotiates Accept-Encoding and compresses JSON/text bodies with brotli or
 * gzip. Implemented on Node's built-in zlib so no extra dependency is needed.
 */
export function compressionMiddleware(options: Partial<CompressionOptions> = {}) {
  const threshold = options.threshold ?? config.compression.threshold;
  const level = options.level ?? config.compression.level;

  return function (req: Request, res: Response, next: NextFunction): void {
    if (!config.compression.enabled) return next();

    const acceptEncoding = req.headers['accept-encoding'];
    const encoding = typeof acceptEncoding === 'string' ? pickEncoding(acceptEncoding) : null;
    if (!encoding) return next();

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    const compressAndSend = (body: Buffer | string): Response => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);

      if (buffer.length < threshold || res.headersSent) {
        return originalSend(buffer);
      }

      const onCompressed = (err: Error | null, compressed: Buffer | undefined) => {
        if (err || !compressed) {
          originalSend(buffer);
          return;
        }
        res.set('Content-Encoding', encoding);
        res.set('Vary', 'Accept-Encoding');
        res.removeHeader('Content-Length');
        originalSend(compressed);
      };

      if (encoding === 'br') {
        zlib.brotliCompress(
          buffer,
          { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level } },
          onCompressed,
        );
      } else {
        zlib.gzip(buffer, { level }, onCompressed);
      }

      return res;
    };

    res.json = function (body: unknown) {
      const json = JSON.stringify(body);
      res.set('Content-Type', 'application/json; charset=utf-8');
      compressAndSend(json);
      return res;
    };

    res.send = function (body: unknown) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        compressAndSend(body as string | Buffer);
        return res;
      }
      return originalJson(body);
    };

    next();
  };
}
