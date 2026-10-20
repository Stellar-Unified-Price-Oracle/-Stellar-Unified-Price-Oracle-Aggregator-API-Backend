// Run: node --test --experimental-strip-types packages/sdk-bindings/tests/checkpoint.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointResumer, MemoryCheckpointStore, type StreamMessage, type GapEvent } from '../src/checkpoint.ts';

async function* gen(seqs: number[], failAfter = false): AsyncIterable<StreamMessage<number>> {
  for (const s of seqs) yield { seq: s, data: s };
  if (failAfter) throw new Error('drop');
}

test('reconnects from checkpoint and drops duplicates', async () => {
  const store = new MemoryCheckpointStore();
  const got: number[] = [];
  const calls: number[] = [];
  const r = new CheckpointResumer<number>({
    streamId: 's', store, sleep: async () => {},
    connect: (from) => { calls.push(from); return calls.length === 1 ? gen([1, 2, 3], true) : gen([2, 3, 4, 5]); },
    onMessage: (m) => { got.push(m.seq); },
  });
  await r.run();
  assert.deepEqual(got, [1, 2, 3, 4, 5]);
  assert.deepEqual(calls, [0, 3]);
  assert.equal(r.stats.duplicatesDropped, 2);
  assert.equal(r.stats.reconnects, 1);
});

test('reports gaps and flags replay truncation', async () => {
  const gaps: GapEvent[] = [];
  const r = new CheckpointResumer<number>({
    streamId: 's', store: new MemoryCheckpointStore(), maxReplay: 5,
    connect: () => gen([1, 2, 20]),
    onMessage: () => {}, onGap: (g) => gaps.push(g),
  });
  await r.run();
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0].from, gaps[0].to], [3, 19]);
  assert.equal(r.stats.missedMessages, 17);
});

test('gives up after maxRetries', async () => {
  const r = new CheckpointResumer<number>({
    streamId: 's', store: new MemoryCheckpointStore(), maxRetries: 2, sleep: async () => {},
    connect: () => gen([], true), onMessage: () => {},
  });
  await assert.rejects(r.run(), /drop/);
  assert.equal(r.stats.reconnects, 2);
});
