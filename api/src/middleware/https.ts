import { Request, Response, NextFunction } from 'express';

export function httpsRedirect(req: Request, res: Response, next: NextFunction): void {
  const proto = req.headers['x-forwarded-proto'] as string | undefined;
  if (proto && proto !== 'https') {
    res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    return;
  }
  next();
}

export function hstsHeaders(req: Request, res: Response, next: NextFunction): void {
  res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  next();
}
