import { Request, Response, NextFunction } from 'express';

export function httpsRedirect(_req: Request, res: Response, next: NextFunction): void {
  const proto = _req.headers['x-forwarded-proto'] as string | undefined;
  if (proto && proto !== 'https') {
    res.redirect(301, `https://${_req.headers.host}${_req.originalUrl}`);
    return;
  }
  next();
}

export function hstsHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  next();
}
