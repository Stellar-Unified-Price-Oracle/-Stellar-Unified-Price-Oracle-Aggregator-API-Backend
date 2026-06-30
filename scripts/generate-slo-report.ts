/**
 * Generates a monthly SLO report by querying Prometheus for each SLO defined
 * in monitoring/slo.yml over the last 30 days, and writes a markdown summary.
 *
 * SLO definitions are mirrored from monitoring/slo.yml below (kept in sync
 * manually) rather than parsed at runtime, to avoid adding a YAML dependency.
 *
 * Usage: tsx scripts/generate-slo-report.ts [--prometheus-url=http://localhost:9090] [--out=./reports]
 */
import fs from 'fs';
import path from 'path';

interface SloDef {
  name: string;
  description: string;
  target: number;
  window: string;
  sli: { good_events: string; total_events: string };
}

const SLOS: SloDef[] = [
  {
    name: 'api-availability',
    description: 'Percentage of API requests that do not return a 5xx error',
    target: 99.9,
    window: '30d',
    sli: {
      good_events: 'sum(rate(http_requests_total{job="stellar-api",status_code!~"5.."}[5m]))',
      total_events: 'sum(rate(http_requests_total{job="stellar-api"}[5m]))',
    },
  },
  {
    name: 'api-latency',
    description: 'Percentage of API requests served under 1s (p95 target)',
    target: 99.0,
    window: '30d',
    sli: {
      good_events: 'sum(rate(http_request_duration_seconds_bucket{job="stellar-api",le="1"}[5m]))',
      total_events: 'sum(rate(http_request_duration_seconds_count{job="stellar-api"}[5m]))',
    },
  },
  {
    name: 'price-freshness',
    description: 'Percentage of time published asset prices are younger than the staleness threshold',
    target: 99.5,
    window: '30d',
    sli: {
      good_events: 'sum(rate(stellar_oracle_price_checks_total{stale="false"}[5m]))',
      total_events: 'sum(rate(stellar_oracle_price_checks_total[5m]))',
    },
  },
];

function parseArgs(): { prometheusUrl: string; outDir: string } {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const found = args.find((a) => a.startsWith(`--${flag}=`));
    return found ? found.split('=').slice(1).join('=') : fallback;
  };
  return {
    prometheusUrl: get('prometheus-url', process.env.PROMETHEUS_URL || 'http://localhost:9090'),
    outDir: get('out', path.resolve(__dirname, '../reports')),
  };
}

async function queryRange(prometheusUrl: string, expr: string): Promise<number | null> {
  const url = `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(`avg_over_time((${expr})[30d:5m])`)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const value = json?.data?.result?.[0]?.value?.[1];
    return value !== undefined ? parseFloat(value) : null;
  } catch (err) {
    console.error(`Failed to query Prometheus for "${expr}":`, (err as Error).message);
    return null;
  }
}

async function main() {
  const { prometheusUrl, outDir } = parseArgs();

  const now = new Date();
  const reportLines: string[] = [
    `# Monthly SLO Report — ${now.toISOString().slice(0, 7)}`,
    '',
    `Generated: ${now.toISOString()}`,
    '',
    '| SLO | Target | Observed (30d) | Status |',
    '|---|---|---|---|',
  ];

  for (const slo of SLOS) {
    const ratio = await queryRange(prometheusUrl, slo.sli.good_events + ' / ' + slo.sli.total_events);
    const observedPercent = ratio !== null ? (ratio * 100).toFixed(3) : 'N/A';
    const status = ratio !== null ? (ratio * 100 >= slo.target ? 'MET' : 'BREACHED') : 'UNKNOWN';
    reportLines.push(`| ${slo.name} | ${slo.target}% | ${observedPercent}% | ${status} |`);
  }

  reportLines.push('', '## SLO Definitions', '');
  for (const slo of SLOS) {
    reportLines.push(`- **${slo.name}**: ${slo.description} (target ${slo.target}%, window ${slo.window})`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `slo-report-${now.toISOString().slice(0, 7)}.md`);
  fs.writeFileSync(outPath, reportLines.join('\n') + '\n', 'utf-8');
  console.log(`SLO report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
