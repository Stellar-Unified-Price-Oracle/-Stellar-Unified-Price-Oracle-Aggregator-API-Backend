import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import { logger } from './logger';

export interface TracingConfig {
  enabled: boolean;
  /** OTLP/HTTP endpoint (e.g. a Jaeger, Tempo, or collector instance). */
  otlpEndpoint?: string;
  samplingRate?: number;
  serviceName?: string;
}

let sdk: NodeSDK | null = null;

export function initializeTracing(config: TracingConfig): void {
  if (!config.enabled) {
    logger.info('Distributed tracing is disabled');
    return;
  }

  const otlpEndpoint = config.otlpEndpoint || 'http://localhost:4318/v1/traces';
  const samplingRate = config.samplingRate || 1.0;
  const serviceName = config.serviceName || 'stellar-oracle-api';

  try {
    const traceExporter = new OTLPTraceExporter({
      url: otlpEndpoint,
    });

    const resource = resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version,
    });

    sdk = new NodeSDK({
      resource,
      traceExporter,
      instrumentations: [getNodeAutoInstrumentations()],
      sampler: new TraceIdRatioBasedSampler(Math.min(samplingRate, 1.0)),
    });

    sdk.start();
    logger.info(`Distributed tracing initialized (endpoint: ${otlpEndpoint}, sampling: ${samplingRate})`);

    process.on('SIGTERM', () => {
      sdk?.shutdown()
        .then(() => logger.info('Tracing SDK shut down successfully'))
        .catch((err) => logger.error('Error shutting down tracing SDK', { error: err }));
    });
  } catch (error) {
    logger.error('Failed to initialize tracing', { error });
    throw error;
  }
}

export function getTracer(name: string) {
  return trace.getTracer(name);
}

export function getActiveSpan() {
  return trace.getActiveSpan();
}
