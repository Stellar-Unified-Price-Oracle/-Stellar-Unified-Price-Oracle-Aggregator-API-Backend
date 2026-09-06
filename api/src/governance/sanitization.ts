import { Request, Response, NextFunction } from 'express';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Strip C0 control chars (\u0000-\u001F) and DEL (\u007F). Implemented as a
// char-code filter (not a regex) so the `no-control-regex` lint rule is satisfied.
function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) out += value[i];
  }
  return out;
}

function sanitizeString(value: string): string {
  // Remove control chars BEFORE trimming so trailing whitespace is still
  // collapsed when the last remaining segment is a control character.
  const decontrolled = stripControlChars(
    value.replace(/<[^>]*>/g, '').replace(/[<>"'`;\\]/g, ''),
  );
  return decontrolled.trim();
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !DANGEROUS_KEYS.has(k))
        .map(([k, v]) => [sanitizeString(k), sanitizeValue(v)]),
    );
  }
  return value;
}

export function sanitizeInputs(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body) as Record<string, unknown>;
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeValue(req.query) as typeof req.query;
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeValue(req.params) as typeof req.params;
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
