import { logger } from '../observability/logger';

export interface DeprecationEvent {
  path: string;
  method: string;
  sunsetOn: string;
  apiKeyId?: string;
  timestamp: number;
}

type DeprecationListener = (event: DeprecationEvent) => void;

/**
 * Tracks usage of deprecated endpoints and notifies subscribers (logging,
 * webhooks, email digests, etc). Webhook/email delivery can subscribe via
 * `onDeprecatedUsage` without coupling the request path to those integrations.
 */
class DeprecationNotifier {
  private listeners: DeprecationListener[] = [];
  private seenKeysByPath: Map<string, Set<string>> = new Map();

  onDeprecatedUsage(listener: DeprecationListener): void {
    this.listeners.push(listener);
  }

  notify(event: DeprecationEvent): void {
    logger.warn(`Deprecated endpoint used: ${event.method} ${event.path}`, event);

    if (event.apiKeyId) {
      const seen = this.seenKeysByPath.get(event.path) || new Set<string>();
      if (!seen.has(event.apiKeyId)) {
        seen.add(event.apiKeyId);
        this.seenKeysByPath.set(event.path, seen);
        for (const listener of this.listeners) {
          listener(event);
        }
      }
    } else {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  getAffectedConsumers(path: string): string[] {
    return Array.from(this.seenKeysByPath.get(path) || []);
  }
}

export const deprecationNotifier = new DeprecationNotifier();
