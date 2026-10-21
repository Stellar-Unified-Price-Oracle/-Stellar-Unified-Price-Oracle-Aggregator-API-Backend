import type { OracleSourceName } from '../infrastructure/types';

export interface ProviderSecurityPolicy {
  allowedHosts: string[];
  allowPrivateIps: boolean;
  allowLocalHostnames: boolean;
  requireHttps: boolean;
}

export interface ProviderTransportCertification {
  provider: OracleSourceName;
  endpointAllowed: boolean;
  endpointError?: string;
  probeCompleted: boolean;
  probeTimedOut: boolean;
  probeElapsedMs: number;
  probeError?: string;
  certified: boolean;
}

export async function certifyProviderTransport(input: {
  provider: OracleSourceName;
  endpoint: string;
  allowedHosts: string[];
  timeoutMs: number;
  validateEndpoint: (endpoint: string, policy: ProviderSecurityPolicy) => unknown;
  probe: (signal: AbortSignal) => Promise<unknown>;
}): Promise<ProviderTransportCertification> {
  const policy: ProviderSecurityPolicy = {
    allowedHosts: input.allowedHosts.map((host) => host.toLowerCase()),
    allowPrivateIps: false,
    allowLocalHostnames: false,
    requireHttps: true,
  };
  let endpointError: string | undefined;
  try {
    input.validateEndpoint(input.endpoint, policy);
  } catch (error) {
    endpointError = error instanceof Error ? error.message : String(error);
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  let probeTimedOut = false;
  let probeError: string | undefined;
  let probeCompleted = false;
  if (!endpointError) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        input.probe(controller.signal).then(() => { if (!probeTimedOut) probeCompleted = true; }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            probeTimedOut = true;
            controller.abort();
            reject(new Error(`provider probe exceeded ${input.timeoutMs}ms`));
          }, input.timeoutMs);
        }),
      ]);
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } else {
    probeError = 'probe skipped because endpoint validation failed';
  }
  const probeElapsedMs = Date.now() - startedAt;
  return {
    provider: input.provider,
    endpointAllowed: !endpointError,
    endpointError,
    probeCompleted,
    probeTimedOut,
    probeElapsedMs,
    probeError,
    certified: !endpointError && probeCompleted && !probeTimedOut && !probeError,
  };
}
