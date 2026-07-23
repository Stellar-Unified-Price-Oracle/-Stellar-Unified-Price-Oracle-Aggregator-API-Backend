import { Request, Response, NextFunction } from 'express';
import { deprecationNotifier } from '../infrastructure/deprecation-notifier';

export interface DeprecationOptions {
  deprecatedOn: string;
  sunsetOn: string;
  link?: string;
  message?: string;
}

export function deprecate(options: DeprecationOptions) {
  const sunsetDate = new Date(options.sunsetOn);

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Deprecation', `date="${options.deprecatedOn}"`);
    res.setHeader('Sunset', sunsetDate.toUTCString());
    if (options.link) {
      res.setHeader('Link', `<${options.link}>; rel="deprecation"`);
    }

    deprecationNotifier.notify({
      path: req.path,
      method: req.method,
      sunsetOn: options.sunsetOn,
      apiKeyId: (req as any).apiKey?.id,
      timestamp: Date.now(),
    });

    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      if (body && typeof body === 'object') {
        body.deprecation = {
          deprecated: true,
          message: options.message || `This endpoint is deprecated and will be removed on ${options.sunsetOn}.`,
          sunset: options.sunsetOn,
        };
      }
      return originalJson(body);
    };

    next();
  };
}
