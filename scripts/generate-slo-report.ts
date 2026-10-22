/**
 * Generates a monthly SLO report by querying Prometheus for each SLO defined
 * in monitoring/slo.yml over the last 30 days, and writes a markdown summary.
 *
 * Definitions are loaded directly from monitoring/slo.yml, the canonical source.
 *
 * Usage: tsx scripts/generate-slo-report.ts [--prometheus-url=http://localhost:9090] [--out=./reports]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

interface SloDef {
  name: string;
  description: string;
  target: number;
  window: string;
  sli: { good_events: string; total_events: string };
}

const sloPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../monitoring/slo.yml');
const SLOS: SloDef[] = (YAML.parse(fs.readFileSync(sloPath, 'utf8')) as { slos: SloDef[] }).slos;

function parseArgs(): { prometheusUrl: string; outDir: string; schedule: boolean; review: boolean } {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const found = args.find((a) => a.startsWith(`--${flag}=`));
    return found ? found.split('=').slice(1).join('=') : fallback;
  };
  const has = (flag: string) => args.includes(`--${flag}`);
  return {
    prometheusUrl: get('prometheus-url', process.env.PROMETHEUS_URL || 'http://localhost:9090'),
    outDir: get('out', path.resolve(__dirname, '../reports')),
    schedule: has('schedule'),
    review: has('review'),
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
  const { prometheusUrl, outDir, schedule, review } = parseArgs();

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

  const reportDir = review ? path.join(outDir, 'drafts') : outDir;
  fs.mkdirSync(reportDir, { recursive: true });
  const outPath = path.join(reportDir, `slo-report-${now.toISOString().slice(0, 7)}.md`);
  fs.writeFileSync(outPath, reportLines.join('\n') + '\n', 'utf-8');
  console.log(`SLO report written to ${outPath}`);

  if (schedule) {
    console.log('Cron schedule for this report (review before submission):');
    console.log('0 0 1 * * tsx scripts/generate-slo-report.ts --review');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
