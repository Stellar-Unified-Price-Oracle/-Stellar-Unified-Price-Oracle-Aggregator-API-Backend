import { Request, Response, NextFunction } from 'express';

export const API_VERSIONS = {
  V1: 'v1',
  V2: 'v2',
} as const;

export type ApiVersion = (typeof API_VERSIONS)[keyof typeof API_VERSIONS];

// v1 is in maintenance mode; minimum supported until 2027-01-01
export const DEPRECATION_SUNSET_DATE = '2027-01-01';
export const DEPRECATION_LINK = 'https://docs.stellar-oracle.io/api/migration/v1-to-v2';

export function v1DeprecationHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set('Deprecation', `date="${new Date('2026-06-29').toUTCString()}"`);
  res.set('Sunset', new Date(DEPRECATION_SUNSET_DATE).toUTCString());
  res.set('Link', `<${DEPRECATION_LINK}>; rel="deprecation"`);
  res.set('X-API-Version', API_VERSIONS.V1);
  next();
}

export function v2Headers(_req: Request, res: Response, next: NextFunction): void {
  res.set('X-API-Version', API_VERSIONS.V2);
  next();
}
