import fs from 'fs';
import path from 'path';

const checkpointFile = path.resolve(process.env.WS_SEQUENCE_FILE || './data/ws-sequence.json');
let sequence = load();

function load(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) as { sequence?: unknown };
    if (typeof parsed.sequence !== 'number' || !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 0) {
      throw new Error(`Invalid WebSocket sequence checkpoint: ${checkpointFile}`);
    }
    return parsed.sequence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export function currentSequence(): number { return sequence; }

export function nextSequence(): number {
  sequence += 1;
  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
  const temporary = `${checkpointFile}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeSync(fd, JSON.stringify({ version: 1, sequence, updatedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, checkpointFile);
  const directoryFd = fs.openSync(path.dirname(checkpointFile), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  return sequence;
}
