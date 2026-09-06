import crypto from 'crypto';

export type LineageStepType =
  | 'source_poll'
  | 'normalization'
  | 'staleness_filter'
  | 'aggregation'
  | 'storage'
  | 'api_response'
  | 'stellar_anchor';

export interface LineageStep {
  type: LineageStepType;
  timestamp: string;
  data: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface LineageRecord {
  provenance_id: string;
  asset: string;
  source_count: number;
  stale_sources: string[];
  median_inputs: string[];
  pipeline_version: string;
  verification_url: string;
  root_hash: string;
  stellar_anchor: {
    status: 'pending' | 'anchored';
    ledger?: string;
    tx_hash?: string;
    network?: string;
    hash: string;
  };
  openlineage: {
    eventType: 'COMPLETE';
    eventTime: string;
    run: { runId: string };
    job: { namespace: string; name: string };
    inputs: Array<{ namespace: string; name: string; facets: Record<string, unknown> }>;
    outputs: Array<{ namespace: string; name: string; facets: Record<string, unknown> }>;
  };
  steps: LineageStep[];
}

const records = new Map<string, LineageRecord>();
const payloadRefs = new Map<string, { compressed: boolean; payload: string; createdAt: string }>();
const pipelineVersion = process.env.PIPELINE_VERSION || '1.0.0';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

function hash(data: unknown, previousHash = ''): string {
  return crypto.createHash('sha256').update(stableStringify(data)).update(previousHash).digest('hex');
}

function step(type: LineageStepType, data: Record<string, unknown>, previousHash = ''): LineageStep {
  const timestamp = new Date().toISOString();
  const body = { type, timestamp, data };
  return { type, timestamp, data, previousHash, hash: hash(body, previousHash) };
}

export function createLineageForPrice(price: Record<string, unknown>, baseUrl = '/api/v1'): LineageRecord {
  const asset = String(price.asset || 'UNKNOWN').toUpperCase();
  const rawSources = Array.isArray(price.sources) ? (price.sources as unknown[]) : [price.source || 'unknown'];
  const sources = rawSources.map((source, index) => ({
    id: `source-${index + 1}`,
    name: String(source),
    status: 'included',
    responseTimeMs: 0,
    httpStatus: 200,
  }));
  const values = sources.map((source) => `${source.id}:${String(price.price || '0')}`);
  const payloadHash = hash({ asset, price, sources });
  payloadRefs.set(payloadHash, {
    compressed: true,
    payload: Buffer.from(stableStringify({ price, sources })).toString('base64'),
    createdAt: new Date().toISOString(),
  });

  const steps = [
    step('source_poll', { sources, raw_payload_ref: payloadHash }),
    step('normalization', { transformations: ['decimal_scaling', 'timestamp_conversion'], decimals: price.decimals }),
  ];
  steps.push(step('staleness_filter', { excluded: [], included: sources.map((s) => s.id) }, steps.at(-1)?.hash));
  steps.push(step('aggregation', { strategy: 'median', median_inputs: values.sort() }, steps.at(-1)?.hash));
  steps.push(step('storage', { destinations: ['history_json', 'soroban_contract'], content_hash: payloadHash }, steps.at(-1)?.hash));
  steps.push(step('api_response', { endpoint: `${baseUrl}/prices/${asset}` }, steps.at(-1)?.hash));
  steps.push(step('stellar_anchor', { status: 'pending', anchor_policy: 'periodic_batch' }, steps.at(-1)?.hash));

  const provenanceId = crypto.randomUUID();
  const rootHash = steps[steps.length - 1].hash;
  const record: LineageRecord = {
    provenance_id: provenanceId,
    asset,
    source_count: sources.length,
    stale_sources: [],
    median_inputs: values,
    pipeline_version: pipelineVersion,
    verification_url: `${baseUrl}/lineage/verify/${provenanceId}`,
    root_hash: rootHash,
    stellar_anchor: { status: 'pending', hash: rootHash },
    openlineage: {
      eventType: 'COMPLETE',
      eventTime: new Date().toISOString(),
      run: { runId: provenanceId },
      job: { namespace: 'stellar-oracle', name: 'price-aggregation' },
      inputs: sources.map((source) => ({
        namespace: 'oracle-source',
        name: source.id,
        facets: { source },
      })),
      outputs: [
        {
          namespace: 'stellar-oracle-api',
          name: asset,
          facets: { rootHash, payloadHash, pipelineVersion },
        },
      ],
    },
    steps,
  };

  records.set(provenanceId, record);
  return record;
}

export function listLineage(asset?: string, from?: string, to?: string): LineageRecord[] {
  const fromMs = from ? Date.parse(from) : 0;
  const toMs = to ? Date.parse(to) : Number.MAX_SAFE_INTEGER;
  return Array.from(records.values()).filter((record) => {
    const time = Date.parse(record.openlineage.eventTime);
    return (!asset || record.asset === asset.toUpperCase()) && time >= fromMs && time <= toMs;
  });
}

export function getLineage(provenanceId: string): LineageRecord | undefined {
  return records.get(provenanceId);
}

export function verifyLineage(provenanceId: string): { valid: boolean; provenanceId: string; rootHash?: string; failedStep?: number } {
  const record = records.get(provenanceId);
  if (!record) return { valid: false, provenanceId };
  let previousHash = '';
  for (let index = 0; index < record.steps.length; index += 1) {
    const current = record.steps[index];
    const expected = hash({ type: current.type, timestamp: current.timestamp, data: current.data }, previousHash);
    if (current.previousHash !== previousHash || current.hash !== expected) {
      return { valid: false, provenanceId, rootHash: record.root_hash, failedStep: index };
    }
    previousHash = current.hash;
  }
  return { valid: previousHash === record.root_hash, provenanceId, rootHash: record.root_hash };
}

export function anchorLineageRecord(
  provenanceId: string,
  anchor: { ledger: string; txHash: string; network?: string },
): LineageRecord | undefined {
  const record = records.get(provenanceId);
  if (!record) return undefined;

  const anchorStep = record.steps.find((step) => step.type === 'stellar_anchor');
  if (anchorStep) {
    anchorStep.data = {
      ...anchorStep.data,
      anchor_policy: 'periodic_batch',
      status: 'anchored',
      ledger: anchor.ledger,
      tx_hash: anchor.txHash,
      network: anchor.network ?? 'testnet',
    };
    anchorStep.hash = hash({ type: anchorStep.type, timestamp: anchorStep.timestamp, data: anchorStep.data }, anchorStep.previousHash);
  }

  record.stellar_anchor = {
    status: 'anchored',
    ledger: anchor.ledger,
    tx_hash: anchor.txHash,
    network: anchor.network ?? 'testnet',
    hash: record.root_hash,
  };

  return record;
}

export function explainLineage(provenanceId: string): string | undefined {
  const record = records.get(provenanceId);
  if (!record) return undefined;
  return `Price ${record.asset} was computed by polling ${record.source_count} source(s), excluding ${record.stale_sources.length} stale source(s), normalizing values, and applying median aggregation over ${record.median_inputs.length} input(s). Integrity is verified by hash ${record.root_hash}.`;
}

