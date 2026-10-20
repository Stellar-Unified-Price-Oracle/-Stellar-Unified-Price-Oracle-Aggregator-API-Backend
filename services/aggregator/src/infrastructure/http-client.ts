import axios, { AxiosHeaders, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { logger } from '../observability/logger';
import { config } from './config';
import { getSecureAgents, validateOutboundUrl, SsrfError } from './ssrf';
import { correlationHeaders } from './correlation';

/**
 * Hardened axios instance for all outbound oracle-source requests.
 *
 * Every request is validated against the SSRF allowlist and routed through
 * agents that re-validate resolved IPs (DNS rebinding mitigation). Blocked
 * attempts are logged with the offending URL and reason and surfaced as
 * {@link SsrfError}.
 *
 * Redirects are never followed automatically (`maxRedirects: 0`). The
 * {@link followRedirects} helper re-validates each hop against the deployment
 * policy before issuing the next request, so a redirect (or a DNS change
 * between hops) cannot bypass the allowlist or reach private destinations.
 */
function buildClient(): AxiosInstance {
  const { httpAgent, httpsAgent } = getSecureAgents();

  const instance = axios.create({
    timeout: config.security.ssrf.requestTimeoutMs,
    maxRedirects: 0, // redirects can bypass allowlist validation
    httpAgent,
    httpsAgent,
  });

  instance.interceptors.request.use((requestConfig) => {
    const correlation = correlationHeaders();
    const existingHeaders = requestConfig.headers ?? {};
    requestConfig.headers = new AxiosHeaders({
      ...existingHeaders,
      ...correlation,
    });

    if (!config.security.ssrf.enabled) return requestConfig;

    const fullUrl = buildFullUrl(requestConfig);
    try {
      validateOutboundUrl(fullUrl);
    } catch (err) {
      if (err instanceof SsrfError) {
        logger.error('[SSRF] Blocked outbound oracle request', {
          url: err.url,
          reason: err.reason,
          message: err.message,
        });
      }
      throw err;
    }
    return requestConfig;
  });

  return instance;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Resolve a possibly-relative redirect target against the URL that produced it.
 */
function resolveRedirectTarget(currentUrl: string, location: string): string {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    throw new SsrfError(location, 'invalid-redirect-target');
  }
}

/**
 * Issue a GET request and follow redirects manually, re-validating every hop
 * against the deployment policy before the next request is sent.
 *
 * - Each hop's absolute URL is checked with {@link validateOutboundUrl}; a
 *   non-allowlisted or private destination aborts the chain with
 *   {@link SsrfError} and is logged.
 * - The number of hops is bounded by `config.security.ssrf.maxRedirects` to
 *   prevent redirect loops.
 * - The final response is returned to the caller; the redirect chain itself is
 *   never handed back.
 */
export async function followRedirects<T>(
  url: string,
  requestConfig?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  const maxHops = config.security.ssrf.maxRedirects;
  let currentUrl = url;
  let currentConfig: AxiosRequestConfig = { ...requestConfig };

  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await getClient().get<T>(currentUrl, currentConfig);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers?.location;
    if (!location || typeof location !== 'string') {
      throw new SsrfError(currentUrl, 'redirect-without-location');
    }

    const nextUrl = resolveRedirectTarget(currentUrl, location);

    if (config.security.ssrf.enabled) {
      try {
        validateOutboundUrl(nextUrl);
      } catch (err) {
        if (err instanceof SsrfError) {
          logger.error('[SSRF] Blocked redirect hop', {
            from: currentUrl,
            to: err.url,
            reason: err.reason,
            message: err.message,
          });
        }
        throw err;
      }
    }

    logger.warn('[SSRF] Following validated redirect hop', {
      from: currentUrl,
      to: nextUrl,
      status: response.status,
    });

    currentUrl = nextUrl;
    // Redirects are GETs; drop any body and method overrides from the caller.
    currentConfig = { ...currentConfig, method: 'get', data: undefined };
  }

  throw new SsrfError(currentUrl, 'too-many-redirects');
}

function buildFullUrl(requestConfig: AxiosRequestConfig): string {
  const base = requestConfig.baseURL || '';
  const url = requestConfig.url || '';
  if (!base) return url;
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (!client) client = buildClient();
  return client;
}

export const httpClient = {
  get<T>(url: string, requestConfig?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return getClient().get<T>(url, requestConfig);
  },
  /**
   * GET with manual, policy-validated redirect handling. Prefer this over
   * {@link httpClient.get} for oracle sources that may issue redirects.
   */
  getFollowingRedirects<T>(
    url: string,
    requestConfig?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return followRedirects<T>(url, requestConfig);
  },
};
