import { Request, Response, NextFunction } from 'express';

// Strip characters that enable XSS / HTML injection
function sanitizeString(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[<>"'`]/g, '')
    .trim();
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeValue(v)]),
    );
  }
  return value;
}

export function sanitizeInputs(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body) as Record<string, unknown>;
  }
  next();
}

export function cspHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  next();
}

const ASSET_RE = /^([A-Z0-9]{1,12}|C[A-Z2-7]{55})$/;

export function validateWsAssets(assets: unknown): assets is string[] {
  return (
    Array.isArray(assets) &&
    assets.length <= 50 &&
    assets.every(
      (a) => typeof a === 'string' && a.length <= 56 && ASSET_RE.test(a.toUpperCase()),
    )
  );
}
