/**
 * Reasons a URL can be rejected. Every reason describes the *caller's* URL or
 * the caller's DNS answer, never this process's own topology, so the value can
 * be surfaced to a user without leaking internal detail.
 */
export type SsrfReason =
  | 'malformed-url'
  | 'protocol'
  | 'https-required'
  | 'allowlist'
  | 'forbidden-host'
  | 'private-ip'
  | 'dns-rebinding'
  | 'dns-empty'
  | 'deployment-allowlist'
  | 'policy-missing'
  | 'policy-malformed'
  | 'redirect-limit';

export class SsrfError extends Error {
  readonly url: string;
  readonly reason: SsrfReason;

  constructor(message: string, url: string, reason: SsrfReason) {
    super(message);
    this.name = 'SsrfError';
    this.url = url;
    this.reason = reason;
  }
}

export function isSsrfError(err: unknown): err is SsrfError {
  return err instanceof SsrfError || (err instanceof Error && err.name === 'SsrfError');
}
