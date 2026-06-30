import fs from 'fs';
import path from 'path';
import { logger } from '../middleware/logger';

const PERSIST_FILE = path.resolve(process.env.CORS_PERSIST_PATH || '/tmp/cors-origins.json');

export class CorsManager {
  private origins: Set<string> = new Set();

  constructor() {
    this.loadDefaults();
    this.loadFromDisk();
  }

  private loadDefaults(): void {
    const envOrigins = process.env.CORS_ALLOWED_ORIGINS;
    if (envOrigins) {
      for (const o of envOrigins.split(',')) {
        const trimmed = o.trim();
        if (trimmed) this.origins.add(trimmed);
      }
    }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(PERSIST_FILE)) {
        const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
        if (Array.isArray(data)) {
          for (const o of data) {
            if (typeof o === 'string') this.origins.add(o);
          }
        }
        logger.info(`Loaded ${this.origins.size} CORS origins from disk`);
      }
    } catch (err) {
      logger.warn('Failed to load persisted CORS origins', err);
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(Array.from(this.origins), null, 2));
    } catch (err) {
      logger.warn('Failed to persist CORS origins', err);
    }
  }

  isAllowed(origin: string): boolean {
    if (this.origins.size === 0) return true;

    for (const pattern of this.origins) {
      if (this.matches(origin, pattern)) return true;
    }
    return false;
  }

  private matches(origin: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === origin) return true;

    // Wildcard subdomain: *.example.com
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // .example.com
      return origin.endsWith(suffix) || origin === suffix.slice(1);
    }
    return false;
  }

  addOrigin(origin: string): boolean {
    if (this.origins.has(origin)) return false;
    this.origins.add(origin);
    this.persist();
    logger.info(`Added CORS origin: ${origin}`);
    return true;
  }

  removeOrigin(origin: string): boolean {
    const removed = this.origins.delete(origin);
    if (removed) {
      this.persist();
      logger.info(`Removed CORS origin: ${origin}`);
    }
    return removed;
  }

  listOrigins(): string[] {
    return Array.from(this.origins);
  }

  getCorsOptions() {
    return {
      origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        if (!origin) return cb(null, true);
        if (this.isAllowed(origin)) return cb(null, true);
        cb(new Error(`CORS origin not allowed: ${origin}`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-request-id', 'If-None-Match', 'If-Modified-Since'],
      exposedHeaders: [
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'Retry-After',
        'ETag',
        'Deprecation',
        'Sunset',
      ],
      // Cache preflight responses in the browser to avoid an OPTIONS
      // round-trip on every request (86400s is the Chromium max).
      maxAge: 86400,
      optionsSuccessStatus: 204,
    };
  }
}

export const corsManager = new CorsManager();
