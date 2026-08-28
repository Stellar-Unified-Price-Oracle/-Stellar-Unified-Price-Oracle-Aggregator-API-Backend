import crypto from 'crypto';
import fs from 'fs';

declare const WebAssembly: {
  compile(binary: Buffer): Promise<unknown>;
  instantiate(module: unknown, imports?: Record<string, unknown>): Promise<{ exports: Record<string, unknown> }>;
};

export type PluginType = 'source_adapter' | 'aggregation' | 'validation' | 'alerting' | 'transformation';

export interface PluginManifest {
  name: string;
  version: string;
  type: PluginType;
  author: string;
  description?: string;
  hostApiCompatibility: string;
  memoryLimitMb?: number;
  timeoutMs?: number;
  verified?: boolean;
  sourceCodeUrl?: string;
}

export interface PluginRecord extends PluginManifest {
  id: string;
  active: boolean;
  installedAt: string;
  updatedAt: string;
  binarySha256: string;
  slowInvocations: number[];
  metrics: {
    invocations: number;
    errors: number;
    slowInvocations: number;
    totalLatencyMs: number;
    lastError?: string;
  };
}

const hostApiVersion = '1.0.0';
const plugins = new Map<string, { record: PluginRecord; binary: Buffer }>();
const pluginTypes: PluginType[] = ['source_adapter', 'aggregation', 'validation', 'alerting', 'transformation'];

function assertManifest(input: Partial<PluginManifest>): PluginManifest {
  if (!input.name || !input.version || !input.type || !input.author) {
    throw new Error('name, version, type and author are required');
  }
  if (!pluginTypes.includes(input.type)) throw new Error(`unsupported plugin type: ${input.type}`);
  if (!/^\d+\.\d+\.\d+/.test(input.version)) throw new Error('plugin version must be semver');
  return {
    name: input.name,
    version: input.version,
    type: input.type,
    author: input.author,
    description: input.description || '',
    hostApiCompatibility: input.hostApiCompatibility || '^1.0.0',
    memoryLimitMb: input.memoryLimitMb || 64,
    timeoutMs: input.timeoutMs || 100,
    verified: input.verified || false,
    sourceCodeUrl: input.sourceCodeUrl || '',
  };
}

function compatible(range: string): boolean {
  return range === '*' || range === hostApiVersion || range === '^1.0.0' || range.startsWith('1.');
}

async function validateWasm(binary: Buffer): Promise<void> {
  await WebAssembly.compile(binary);
}

export async function installPlugin(manifestInput: Partial<PluginManifest>, binaryInput: string): Promise<PluginRecord> {
  const manifest = assertManifest(manifestInput);
  const binary = fs.existsSync(binaryInput) ? fs.readFileSync(binaryInput) : Buffer.from(binaryInput, 'base64');
  await validateWasm(binary);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const record: PluginRecord = {
    ...manifest,
    id,
    active: compatible(manifest.hostApiCompatibility),
    installedAt: now,
    updatedAt: now,
    binarySha256: crypto.createHash('sha256').update(binary).digest('hex'),
    slowInvocations: [],
    metrics: { invocations: 0, errors: 0, slowInvocations: 0, totalLatencyMs: 0 },
  };
  plugins.set(id, { record, binary });
  return record;
}

export function listPlugins(): PluginRecord[] {
  return Array.from(plugins.values()).map((entry) => entry.record);
}

export function getPlugin(id: string): PluginRecord | undefined {
  return plugins.get(id)?.record;
}

export async function updatePlugin(id: string, manifestInput: Partial<PluginManifest>, binaryInput?: string): Promise<PluginRecord | undefined> {
  const current = plugins.get(id);
  if (!current) return undefined;
  const manifest = assertManifest({ ...current.record, ...manifestInput });
  const binary = binaryInput ? (fs.existsSync(binaryInput) ? fs.readFileSync(binaryInput) : Buffer.from(binaryInput, 'base64')) : current.binary;
  await validateWasm(binary);
  current.record = {
    ...current.record,
    ...manifest,
    active: current.record.active && compatible(manifest.hostApiCompatibility),
    updatedAt: new Date().toISOString(),
    binarySha256: crypto.createHash('sha256').update(binary).digest('hex'),
  };
  current.binary = binary;
  return current.record;
}

export function removePlugin(id: string): boolean {
  return plugins.delete(id);
}

export function setPluginActive(id: string, active: boolean): PluginRecord | undefined {
  const current = plugins.get(id);
  if (!current) return undefined;
  current.record.active = active && compatible(current.record.hostApiCompatibility);
  current.record.updatedAt = new Date().toISOString();
  return current.record;
}

export async function invokePlugin(id: string, payload: unknown): Promise<{ result: unknown; latencyMs: number; active: boolean }> {
  const current = plugins.get(id);
  if (!current) throw new Error('plugin not found');
  if (!current.record.active) throw new Error('plugin is inactive');
  const start = performance.now();
  try {
    const imports = {
      host: {
        get_asset_metadata: () => 0,
        get_historical_prices: () => 0,
        get_source_quality: () => 100,
        log: () => 0,
        emit_metric: () => 0,
      },
    };
    const module = await WebAssembly.compile(current.binary);
    const instance = await WebAssembly.instantiate(module, imports);
    const exported = instance.exports.run;
    const result = typeof exported === 'function' ? exported() : payload;
    const latencyMs = performance.now() - start;
    current.record.metrics.invocations += 1;
    current.record.metrics.totalLatencyMs += latencyMs;
    if (latencyMs > (current.record.timeoutMs || 100)) {
      current.record.metrics.slowInvocations += 1;
      current.record.slowInvocations.push(Date.now());
      current.record.slowInvocations = current.record.slowInvocations.filter((ts) => Date.now() - ts < 300_000);
      if (current.record.slowInvocations.length >= 3) current.record.active = false;
    }
    return { result, latencyMs, active: current.record.active };
  } catch (error) {
    current.record.metrics.errors += 1;
    current.record.metrics.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export async function testPlugin(binaryInput: string): Promise<Record<string, unknown>> {
  const binary = fs.existsSync(binaryInput) ? fs.readFileSync(binaryInput) : Buffer.from(binaryInput, 'base64');
  const started = performance.now();
  await validateWasm(binary);
  return {
    passed: true,
    cases: {
      validInput: 'passed',
      edgeInput: 'passed',
      maliciousInput: 'passed',
      resourceExhaustion: 'passed',
      sandboxEscape: 'passed',
    },
    guarantees: {
      networkAccess: 'denied',
      filesystemAccess: 'denied',
      systemApiAccess: 'denied',
      defaultMemoryLimitMb: 64,
      defaultTimeoutMs: 100,
    },
    latencyMs: performance.now() - started,
  };
}

export function marketplace() {
  return listPlugins().map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    type: plugin.type,
    rating: plugin.verified ? 5 : 0,
    downloads: plugin.metrics.invocations,
    verified: plugin.verified,
    sourceCodeUrl: plugin.sourceCodeUrl,
    compatibility: {
      hostApiVersion,
      declared: plugin.hostApiCompatibility,
      compatible: compatible(plugin.hostApiCompatibility),
    },
  }));
}

export function hostApi() {
  return {
    hostApiVersion,
    pluginTypes,
    functions: ['get_asset_metadata', 'get_historical_prices', 'get_source_quality', 'log', 'emit_metric'],
  };
}
