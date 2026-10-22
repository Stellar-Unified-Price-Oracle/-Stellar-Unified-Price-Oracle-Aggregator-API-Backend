import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPath = process.env.WS_SEQUENCE_FILE;
let tempDir = '';

afterEach(() => {
  vi.resetModules();
  if (originalPath === undefined) delete process.env.WS_SEQUENCE_FILE;
  else process.env.WS_SEQUENCE_FILE = originalPath;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('durable WebSocket sequence checkpoint (#712)', () => {
  it('continues from the atomically written checkpoint after module restart', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sequence-'));
    process.env.WS_SEQUENCE_FILE = path.join(tempDir, 'sequence.json');
    vi.resetModules();
    const first = await import('../../src/infrastructure/ws-sequence');
    expect(first.currentSequence()).toBe(0);
    expect(first.nextSequence()).toBe(1);
    expect(first.nextSequence()).toBe(2);

    vi.resetModules();
    const restarted = await import('../../src/infrastructure/ws-sequence');
    expect(restarted.currentSequence()).toBe(2);
    expect(restarted.nextSequence()).toBe(3);
  });
});
