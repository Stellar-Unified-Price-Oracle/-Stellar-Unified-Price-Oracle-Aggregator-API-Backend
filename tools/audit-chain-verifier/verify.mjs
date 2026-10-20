import crypto from 'node:crypto';

/**
 * Independent re-implementation of the audit chain rules from
 * api/src/governance/audit-logger.ts. It imports nothing from the API and
 * needs only the log file and the plaintext signing keys.
 */

export function fingerprint(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export function canonicalPayload(entry, previousHmac) {
  const payload = {};
  for (const k of ['event', 'timestamp', 'ip', 'userAgent', 'apiKeyPrefix', 'keyId', 'writerId', 'seq', 'details', 'prevState', 'newState']) {
    if (entry[k] !== undefined) payload[k] = entry[k];
  }
  payload.prevHmac = previousHmac;
  return JSON.stringify(payload);
}

export function parseLog(text) {
  const entries = [];
  const malformed = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed.push(i + 1);
    }
  });
  return { entries, malformed };
}

/**
 * @param {object[]} entries parsed log entries in file order
 * @param {{secrets: string[], anchors?: Array<{writerId?: string, seq?: number, hmac: string}>}} opts
 * @returns {{valid: boolean, entries: number, writers: number, findings: object[]}}
 */
export function verifyChain(entries, { secrets, anchors = [] }) {
  const keyring = new Map(secrets.map((s) => [fingerprint(s), s]));
  const current = secrets.length ? fingerprint(secrets[secrets.length - 1]) : undefined;
  const findings = [];
  const hmacIndex = new Map();
  const byWriter = new Map();

  entries.forEach((entry, index) => {
    hmacIndex.set(entry.hmac, index);
    const w = entry.writerId ?? 'legacy';
    if (!byWriter.has(w)) byWriter.set(w, []);
    byWriter.get(w).push({ entry, index });
  });

  const fail = (index, code, message) => findings.push({ index, code, message });

  for (const [writer, group] of byWriter) {
    let previous = null;
    for (const { entry, index } of group) {
      if (typeof entry.hmac !== 'string') {
        fail(index, 'missing-hmac', `entry ${index} has no hmac`);
        previous = null;
        continue;
      }
      const expectedPrev = previous ? previous.hmac : (entry.prevHmac ?? '');
      if ((entry.prevHmac ?? '') !== expectedPrev) fail(index, 'broken-link', `entry ${index} (${writer}) prevHmac does not match predecessor`);
      if (previous && entry.seq != null && previous.seq != null && entry.seq !== previous.seq + 1) {
        fail(index, 'sequence-gap', `entry ${index} (${writer}) seq ${entry.seq} follows ${previous.seq}`);
      }
      const secret = entry.keyId ? keyring.get(entry.keyId) : keyring.get(current);
      if (!secret) {
        fail(index, 'unknown-key', `entry ${index} signed with unavailable key ${entry.keyId ?? '(current)'}`);
      } else {
        const fields = { ...entry };
        delete fields.hmac;
        const mac = crypto.createHmac('sha256', secret).update(canonicalPayload(fields, entry.prevHmac ?? '')).digest('hex');
        if (!safeEqual(mac, entry.hmac)) fail(index, 'bad-hmac', `entry ${index} (${writer}) hmac mismatch`);
      }
      if (!previous && (entry.prevHmac ?? '') !== '') {
        const anchorIndex = hmacIndex.get(entry.prevHmac);
        if ((anchorIndex === undefined || anchorIndex > index) && index !== 0) {
          fail(index, 'unanchored-writer', `first entry of writer ${writer} does not anchor to an earlier entry`);
        }
      }
      previous = entry;
    }
  }

  // External anchors: a trusted copy of a (writer, seq, hmac) head recorded elsewhere.
  for (const a of anchors) {
    const hit = entries.find((e) => e.hmac === a.hmac);
    if (!hit) {
      fail(-1, 'anchor-missing', `anchor ${a.hmac} not found in log (truncated or rewritten?)`);
    } else if (a.writerId !== undefined && (hit.writerId ?? 'legacy') !== a.writerId) {
      fail(-1, 'anchor-writer-mismatch', `anchor ${a.hmac} belongs to a different writer`);
    } else if (a.seq !== undefined && hit.seq !== a.seq) {
      fail(-1, 'anchor-seq-mismatch', `anchor ${a.hmac} has seq ${hit.seq}, expected ${a.seq}`);
    }
  }

  return { valid: findings.length === 0, entries: entries.length, writers: byWriter.size, findings };
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Returns the latest hmac per writer, suitable for storing as external anchors. */
export function exportAnchors(entries) {
  const heads = new Map();
  for (const e of entries) heads.set(e.writerId ?? 'legacy', e);
  return [...heads].map(([writerId, e]) => ({ writerId, seq: e.seq, hmac: e.hmac }));
}
