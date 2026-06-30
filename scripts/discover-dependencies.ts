/**
 * Discovers runtime service dependencies from docker-compose.yml and known
 * external oracle sources, and writes:
 *   - monitoring/dependency-graph.json (nodes/edges + health check endpoints)
 *   - monitoring/dependency-graph.mmd  (Mermaid graph for docs/README embedding)
 *
 * This is static discovery (parsed from config), paired with the runtime
 * dependency status page (monitoring/status-page/) which polls each node's
 * health endpoint and color-codes the same graph live.
 *
 * Usage: tsx scripts/discover-dependencies.ts
 */
import fs from 'fs';
import path from 'path';

interface DependencyNode {
  id: string;
  type: 'service' | 'database' | 'external-oracle' | 'blockchain';
  healthCheckUrl?: string;
}

interface DependencyEdge {
  from: string;
  to: string;
}

const COMPOSE_FILE = path.resolve(__dirname, '../docker-compose.yml');

function discoverFromCompose(): { nodes: DependencyNode[]; edges: DependencyEdge[] } {
  const raw = fs.readFileSync(COMPOSE_FILE, 'utf-8');
  const nodes: DependencyNode[] = [];
  const edges: DependencyEdge[] = [];

  // Minimal indentation-aware parse: we only need top-level service names,
  // their `depends_on` children, and the healthcheck URL if present.
  const lines = raw.split('\n');
  let currentService: string | null = null;
  let inDependsOn = false;

  for (const line of lines) {
    const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (serviceMatch && !line.startsWith('    ')) {
      currentService = serviceMatch[1];
      inDependsOn = false;
      if (currentService !== 'volumes' && currentService !== 'networks') {
        const type: DependencyNode['type'] = currentService === 'timescaledb' ? 'database' : 'service';
        nodes.push({ id: currentService, type });
      }
      continue;
    }

    if (!currentService) continue;

    if (/^\s{4}depends_on:/.test(line)) {
      inDependsOn = true;
      continue;
    }
    if (inDependsOn) {
      const depMatch = line.match(/^\s{6}([a-zA-Z0-9_-]+):\s*$/);
      if (depMatch) {
        edges.push({ from: currentService, to: depMatch[1] });
        continue;
      }
      if (!/^\s{6,}/.test(line)) {
        inDependsOn = false;
      }
    }

    const healthMatch = line.match(/http:\/\/localhost:(\d+)([^\s"]*)/);
    if (healthMatch && /healthcheck|CMD/.test(raw.split('\n').slice(Math.max(0, lines.indexOf(line) - 2), lines.indexOf(line) + 1).join('\n'))) {
      const node = nodes.find((n) => n.id === currentService);
      if (node) node.healthCheckUrl = `http://localhost:${healthMatch[1]}${healthMatch[2]}`;
    }
  }

  // External oracle sources are configured via env (see services/aggregator/src/config.ts)
  // and the aggregator depends on all of them to compute a consensus price.
  const externalSources = ['chainlink', 'redstone', 'band', 'reflector'];
  for (const src of externalSources) {
    nodes.push({ id: src, type: 'external-oracle' });
    edges.push({ from: 'aggregator', to: src });
  }

  // The aggregator publishes consensus prices to a Soroban smart contract.
  nodes.push({ id: 'soroban-contract', type: 'blockchain' });
  edges.push({ from: 'aggregator', to: 'soroban-contract' });

  return { nodes, edges };
}

function toMermaid(graph: { nodes: DependencyNode[]; edges: DependencyEdge[] }): string {
  const lines = ['graph LR'];
  for (const node of graph.nodes) {
    lines.push(`  ${node.id}["${node.id} (${node.type})"]`);
  }
  for (const edge of graph.edges) {
    lines.push(`  ${edge.from} --> ${edge.to}`);
  }
  return lines.join('\n');
}

function main() {
  const graph = discoverFromCompose();
  const outDir = path.resolve(__dirname, '../monitoring');

  fs.writeFileSync(path.join(outDir, 'dependency-graph.json'), JSON.stringify(graph, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(outDir, 'dependency-graph.mmd'), toMermaid(graph) + '\n', 'utf-8');

  console.log(`Discovered ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  console.log('Wrote monitoring/dependency-graph.json and monitoring/dependency-graph.mmd');
}

main();
