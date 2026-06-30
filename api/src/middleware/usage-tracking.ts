import { Request, Response, NextFunction } from 'express';
import { usageAnalytics } from '../services/usage-analytics';

export function usageTrackingMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const apiKeyPrefix = req.apiKey ? req.apiKey.substring(0, 8) : 'anonymous';
    const asset =
      (req.params && (req.params.asset as string | undefined)) ||
      (typeof req.query.asset === 'string' ? req.query.asset : undefined);

    usageAnalytics.record({
      endpoint: req.route ? req.baseUrl + req.route.path : req.path,
      method: req.method,
      apiKeyPrefix,
      asset: asset ? asset.toUpperCase() : undefined,
      status: res.statusCode,
      timestamp: Date.now(),
    });
  });
  next();
}
