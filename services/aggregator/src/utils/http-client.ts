import axios, { AxiosHeaders, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { logger } from './logger';
import { config } from '../config';
import { getSecureAgents, validateOutboundUrl, SsrfError } from './ssrf';
import { correlationHeaders } from './correlation';

/**
 * Hardened axios instance for all outbound oracle-source requests.
 *
 * Every request is validated against the SSRF allowlist and routed through
 * agents that re-validate resolved IPs (DNS rebinding mitigation). Blocked
 * attempts are logged with the offending URL and reason and surfaced as
 * {@link SsrfError}.
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
  // Mirrors axios's default `AxiosResponse<any>` so existing source call-sites
  // keep their loose `response.data?.x` access patterns.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get<T = any>(url: string, requestConfig?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return getClient().get<T>(url, requestConfig);
  },
};
