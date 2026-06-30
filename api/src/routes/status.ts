import { Router, Request, Response } from 'express';
import { uptimeTracker } from '../services/uptime-tracker';

const router = Router();

const STATUS_LABEL: Record<string, string> = {
  operational: 'Operational',
  degraded: 'Degraded Performance',
  down: 'Major Outage',
};

const STATUS_COLOR: Record<string, string> = {
  operational: '#2ecc71',
  degraded: '#f39c12',
  down: '#e74c3c',
};

router.get('/', (req: Request, res: Response) => {
  const components = uptimeTracker.getComponents();
  const incidents = uptimeTracker.getIncidents(20);
  const overall = uptimeTracker.overallStatus();

  if (req.accepts('html')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderHtml(overall, components, incidents));
    return;
  }

  res.json({
    status: overall,
    statusLabel: STATUS_LABEL[overall],
    components,
    incidents,
    generatedAt: Math.floor(Date.now() / 1000),
  });
});

function renderHtml(
  overall: string,
  components: ReturnType<typeof uptimeTracker.getComponents>,
  incidents: ReturnType<typeof uptimeTracker.getIncidents>,
): string {
  const color = STATUS_COLOR[overall] ?? '#95a5a6';
  const label = STATUS_LABEL[overall] ?? overall;

  const componentRows = components.map((c) => {
    const dot = STATUS_COLOR[c.status] ?? '#95a5a6';
    const updated = c.lastCheckedAt
      ? new Date(c.lastCheckedAt * 1000).toISOString()
      : 'Never';
    return `
      <tr>
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dot};margin-right:8px"></span>${esc(c.name)}</td>
        <td style="color:${dot}">${esc(STATUS_LABEL[c.status] ?? c.status)}</td>
        <td>${c.uptimePercent.toFixed(2)}%</td>
        <td style="font-size:0.85em;color:#666">${updated}</td>
      </tr>`;
  }).join('');

  const incidentItems = incidents.length === 0
    ? '<p style="color:#666;font-style:italic">No incidents in the last 30 days.</p>'
    : incidents.map((inc) => {
      const started = new Date(inc.startedAt * 1000).toISOString();
      const resolved = inc.resolvedAt ? new Date(inc.resolvedAt * 1000).toISOString() : null;
      const badge = inc.resolvedAt
        ? `<span style="background:#2ecc71;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.8em">Resolved</span>`
        : `<span style="background:#e74c3c;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.8em">Active</span>`;
      return `
        <div style="border:1px solid #eee;border-radius:8px;padding:16px;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
            ${badge}
            <strong>${esc(inc.id)}: ${esc(inc.title)}</strong>
          </div>
          <div style="font-size:0.85em;color:#666">
            Component: ${esc(inc.component)} &bull; Started: ${started}${resolved ? ` &bull; Resolved: ${resolved}` : ''}
          </div>
          ${inc.updates.map((u) => `<div style="margin-top:8px;font-size:0.9em;color:#444;padding-left:8px;border-left:3px solid #ddd">${new Date(u.timestamp * 1000).toISOString()} — ${esc(u.message)}</div>`).join('')}
        </div>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>Stellar Price Oracle — Status</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;margin:0;padding:0;background:#f8f9fa;color:#2d3748}
    .hero{background:${color};color:#fff;padding:48px 24px;text-align:center}
    .hero h1{margin:0 0 8px;font-size:2rem}
    .hero p{margin:0;opacity:.9}
    .container{max-width:900px;margin:32px auto;padding:0 16px}
    .card{background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.08);padding:24px;margin-bottom:24px}
    .card h2{margin-top:0;font-size:1.1rem;color:#444;border-bottom:1px solid #eee;padding-bottom:12px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;font-size:0.8rem;text-transform:uppercase;letter-spacing:.05em;color:#888;padding:8px 0}
    td{padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:middle}
    tr:last-child td{border:none}
    footer{text-align:center;font-size:0.8em;color:#aaa;margin:32px 0;padding-bottom:32px}
  </style>
</head>
<body>
  <div class="hero">
    <h1>${esc(label)}</h1>
    <p>Stellar Unified Price Oracle &amp; Aggregator</p>
  </div>
  <div class="container">
    <div class="card">
      <h2>Components</h2>
      ${components.length === 0 ? '<p style="color:#aaa;font-style:italic">Monitoring probes initializing…</p>' : `
      <table>
        <thead><tr><th>Component</th><th>Status</th><th>Uptime (24 h)</th><th>Last checked</th></tr></thead>
        <tbody>${componentRows}</tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>Incident History</h2>
      ${incidentItems}
    </div>
  </div>
  <footer>Auto-refreshes every 60 s &bull; Data updated every minute &bull; <a href="/api/v1/status">JSON API</a></footer>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default router;
