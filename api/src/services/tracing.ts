import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { BatchSpanProcessor, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import { logger } from '../middleware/logger';

export interface TracingConfig {
  enabled: boolean;
  jaegerEndpoint?: string;
  samplingRate?: number;
  serviceName?: string;
}

let sdk: NodeSDK | null = null;

export function initializeTracing(config: TracingConfig): void {
  if (!config.enabled) {
    logger.info('Distributed tracing is disabled');
    return;
  }

  const jaegerEndpoint = config.jaegerEndpoint || 'http://localhost:14268/api/traces';
  const samplingRate = config.samplingRate || 1.0;
  const serviceName = config.serviceName || 'stellar-oracle-api';

  try {
    const jaegerExporter = new JaegerExporter({
      endpoint: jaegerEndpoint,
    });

    const resource = Resource.default().merge(
      new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version,
      }),
    );

    sdk = new NodeSDK({
      resource,
      traceExporter: jaegerExporter,
      instrumentations: [getNodeAutoInstrumentations()],
      sampler: new TraceIdRatioBasedSampler(Math.min(samplingRate, 1.0)),
    });

    sdk.start();
    logger.info(`Distributed tracing initialized (endpoint: ${jaegerEndpoint}, sampling: ${samplingRate})`);

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
