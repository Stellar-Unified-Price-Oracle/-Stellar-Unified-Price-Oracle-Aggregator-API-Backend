import { NormalizedPrice } from '../infrastructure/types';

export interface SourceRequest<T> {
  source: string;
  asset: string;
  run: () => Promise<T>;
}

export async function fanOutFetch<T>(
  requests: SourceRequest<T>[],
  maxConcurrency = 40,
): Promise<Array<{ request: SourceRequest<T>; result?: T; error?: Error }>> {
  const queue = [...requests];
  const results: Array<{ request: SourceRequest<T>; result?: T; error?: Error }> = [];

  async function worker(): Promise<void> {
    for (;;) {
      const request = queue.shift();
      if (!request) return;
      try {
        results.push({ request, result: await request.run() });
      } catch (error) {
        results.push({ request, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, requests.length) }, worker));
  return results;
}

export class IncrementalMedian {
  private values: bigint[] = [];

  upsert(value: bigint): bigint {
    const next = [...this.values, value].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.values = next;
    return this.median();
  }

  remove(value: bigint): bigint | null {
    const index = this.values.indexOf(value);
    if (index >= 0) this.values.splice(index, 1);
    return this.values.length > 0 ? this.median() : null;
  }

  median(): bigint {
    if (this.values.length === 0) return 0n;
    const mid = Math.floor(this.values.length / 2);
    if (this.values.length % 2 === 1) return this.values[mid];
    return (this.values[mid - 1] + this.values[mid]) / 2n;
  }
}

export class BatchHistoryBuffer {
  private buffer: NormalizedPrice[] = [];
  private lastFlushMs = Date.now();

  constructor(
    private readonly maxEvents = 1000,
    private readonly maxAgeMs = 1000,
  ) {}

  push(price: NormalizedPrice): NormalizedPrice[] {
    this.buffer.push(price);
    if (this.buffer.length >= this.maxEvents || Date.now() - this.lastFlushMs >= this.maxAgeMs) {
      return this.flush();
    }
    return [];
  }

  flush(): NormalizedPrice[] {
    const flushed = this.buffer;
    this.buffer = [];
    this.lastFlushMs = Date.now();
    return flushed;
  }
}

export interface PipelineBenchmark {
  sustainedTps: number;
  p99LatencyMs: number;
  sourceFanoutMs: number;
  batchWriteEventsPerSecond: number;
  eventLoopBlockMs: number;
}

export function assertPerformanceTargets(result: PipelineBenchmark): string[] {
  const failures: string[] = [];
  if (result.sustainedTps < 100000) failures.push('sustained TPS below 100k');
  if (result.p99LatencyMs > 100) failures.push('p99 latency above 100ms');
  if (result.sourceFanoutMs > 500) failures.push('source fanout above 500ms');
  if (result.batchWriteEventsPerSecond < 100000) failures.push('batch writes below 100k events/s');
  if (result.eventLoopBlockMs > 1) failures.push('event loop blocked above 1ms');
  return failures;
}
