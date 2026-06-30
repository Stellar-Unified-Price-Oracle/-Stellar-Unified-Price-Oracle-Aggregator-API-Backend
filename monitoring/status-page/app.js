// Real-time dependency status page. Loads the statically discovered graph
// (monitoring/dependency-graph.json) then polls each node's health check
// endpoint to color-code health. External oracle sources and the Soroban
// contract have no direct browser-reachable health endpoint, so their
// status is derived from the aggregator's /health response (sourceHealth
// and circuit breaker state per source).

const POLL_INTERVAL_MS = 10000;

async function loadGraph() {
  const res = await fetch('../dependency-graph.json');
  return res.json();
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    return { ok: true, status: res.status, body: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
  }
}

function statusClass(status) {
  if (status === 'healthy') return 'healthy';
  if (status === 'degraded') return 'degraded';
  if (status === 'unhealthy') return 'unhealthy';
  return 'unknown';
}

function renderGraph(graph, statuses) {
  const container = document.getElementById('graph');
  container.innerHTML = '';
  for (const node of graph.nodes) {
    const status = statuses[node.id] || 'unknown';
    const el = document.createElement('div');
    el.className = `node ${statusClass(status)}`;
    el.innerHTML = `
      <div class="id">${node.id}</div>
      <div class="type">${node.type}</div>
      <div class="status">${status}</div>
    `;
    container.appendChild(el);
  }
  document.getElementById('updated').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
}

async function computeStatuses(graph) {
  const statuses = {};

  for (const node of graph.nodes.filter((n) => n.healthCheckUrl)) {
    const result = await fetchJson(node.healthCheckUrl);
    if (!result.ok) {
      statuses[node.id] = 'unhealthy';
      continue;
    }
    statuses[node.id] = result.body?.status || 'healthy';
  }

  // Derive external oracle source / contract health from the aggregator's
  // own health snapshot, since they aren't directly reachable from a browser.
  const aggregator = graph.nodes.find((n) => n.id === 'aggregator');
  if (aggregator?.healthCheckUrl) {
    const result = await fetchJson(`${aggregator.healthCheckUrl}?verbose=true`);
    const sourceHealth = result.body?.sourceHealth || {};
    for (const node of graph.nodes) {
      if (node.type === 'external-oracle' && sourceHealth[node.id]) {
        statuses[node.id] = sourceHealth[node.id].healthy ? 'healthy' : 'unhealthy';
      }
    }
  }

  return statuses;
}

async function tick(graph) {
  const statuses = await computeStatuses(graph);
  renderGraph(graph, statuses);
}

async function main() {
  const graph = await loadGraph();
  renderGraph(graph, {});
  await tick(graph);
  setInterval(() => tick(graph), POLL_INTERVAL_MS);
}

main();
