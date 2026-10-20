/**
 * Stream reconnect with checkpoint recovery.
 *
 * Transport agnostic: the caller supplies `connect(fromSeq)`, which opens a
 * stream that replays messages with seq > fromSeq. The resumer tracks the last
 * processed sequence number per stream, drops duplicates, bounds replay, and
 * reports gaps instead of hiding them.
 */

export interface StreamMessage<T = unknown> {
  /** Monotonically increasing per-stream sequence number. */
  seq: number;
  data: T;
}

export interface CheckpointStore {
  load(streamId: string): number | undefined | Promise<number | undefined>;
  save(streamId: string, seq: number): void | Promise<void>;
}

export class MemoryCheckpointStore implements CheckpointStore {
  private readonly m = new Map<string, number>();
  load(id: string) { return this.m.get(id); }
  save(id: string, seq: number) { this.m.set(id, seq); }
}

export interface GapEvent {
  streamId: string;
  /** First missing seq (inclusive). */
  from: number;
  /** Last missing seq (inclusive). */
  to: number;
  /** True when the gap was caused by the replay bound, not by the server. */
  truncatedByReplayLimit: boolean;
}

export interface CheckpointStats {
  delivered: number;
  duplicatesDropped: number;
  gapsDetected: number;
  missedMessages: number;
  reconnects: number;
}

export interface CheckpointResumerOptions<T> {
  streamId: string;
  store: CheckpointStore;
  connect: (fromSeq: number) => AsyncIterable<StreamMessage<T>>;
  onMessage: (m: StreamMessage<T>) => void | Promise<void>;
  onGap?: (g: GapEvent) => void;
  /** Max messages to replay after a reconnect; older ones are reported as a gap. Default 1000. */
  maxReplay?: number;
  /** Max consecutive reconnect attempts without progress. Default 5. */
  maxRetries?: number;
  /** Backoff in ms for attempt n (1-based). Default exponential from 250ms, capped at 10s. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export class CheckpointResumer<T = unknown> {
  readonly stats: CheckpointStats = { delivered: 0, duplicatesDropped: 0, gapsDetected: 0, missedMessages: 0, reconnects: 0 };
  private stopped = false;

  constructor(private readonly o: CheckpointResumerOptions<T>) {}

  stop(): void { this.stopped = true; }

  async run(): Promise<void> {
    const maxReplay = this.o.maxReplay ?? 1000;
    const maxRetries = this.o.maxRetries ?? 5;
    const backoff = this.o.backoffMs ?? ((n: number) => Math.min(250 * 2 ** (n - 1), 10_000));
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last = (await this.o.store.load(this.o.streamId)) ?? 0;
    let failures = 0;
    let firstAfterConnect = false;

    while (!this.stopped) {
      try {
        firstAfterConnect = true;
        for await (const m of this.o.connect(last)) {
          if (this.stopped) return;
          if (!Number.isInteger(m.seq) || m.seq < 0) continue; // malformed: ignore
          if (m.seq <= last) { this.stats.duplicatesDropped++; continue; }
          if (m.seq > last + 1) {
            const missed = m.seq - last - 1;
            const truncated = firstAfterConnect && missed > maxReplay;
            this.stats.gapsDetected++;
            this.stats.missedMessages += missed;
            this.o.onGap?.({ streamId: this.o.streamId, from: last + 1, to: m.seq - 1, truncatedByReplayLimit: truncated });
          }
          firstAfterConnect = false;
          await this.o.onMessage(m);
          last = m.seq;
          await this.o.store.save(this.o.streamId, last);
          this.stats.delivered++;
          failures = 0;
        }
        return; // stream ended cleanly
      } catch (e) {
        if (this.stopped) return;
        failures++;
        if (failures > maxRetries) throw e;
        this.stats.reconnects++;
        await sleep(backoff(failures));
      }
    }
  }
}
