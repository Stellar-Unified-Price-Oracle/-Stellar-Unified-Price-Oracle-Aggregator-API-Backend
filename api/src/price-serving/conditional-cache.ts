import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

function computeETag(body: unknown): string {
  const hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  return `"${hash}"`;
}

export function conditionalCache(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET') return next();

  const lastModified = new Date();
  const originalJson = res.json.bind(res);

  res.json = (body: unknown) => {
    const etag = computeETag(body);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified.toUTCString());
    res.setHeader('Cache-Control', 'no-cache');

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(304);
      return res.end();
    }

    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince) {
      const since = new Date(ifModifiedSince);
      if (!isNaN(since.getTime()) && lastModified.getTime() <= since.getTime()) {
        res.status(304);
        return res.end();
      }
    }

    return originalJson(body);
  };

  next();
}
