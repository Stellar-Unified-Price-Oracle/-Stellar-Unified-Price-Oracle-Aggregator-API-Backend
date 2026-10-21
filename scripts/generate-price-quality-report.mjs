import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(await readFile(path.join(root, 'verification/fixtures/price-quality-regimes.json'), 'utf8'));
const regimes = new Map();
let tp = 0, fp = 0, fn = 0, tn = 0, errorTotal = 0, sourceCount = 0, matched = 0;
const median = (values) => { const xs = [...values].sort((a, b) => a - b); const m = Math.floor(xs.length / 2); return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; };
for (const c of corpus.cases) {
  const center = median(c.sources.map((s) => s.price));
  let stats = regimes.get(c.regime);
  if (!stats) { stats = { cases: 0, sources: 0, error: 0 }; regimes.set(c.regime, stats); }
  stats.cases++;
  for (const s of c.sources) {
    const predicted = Math.abs(s.price - center) / Math.abs(center) > 0.1;
    if (predicted && s.anomaly) tp++; else if (predicted) fp++; else if (s.anomaly) fn++; else tn++;
    errorTotal += Math.abs(s.price - c.reference) / Math.abs(c.reference) * 100;
    stats.error += Math.abs(s.price - c.reference) / Math.abs(c.reference) * 100;
    stats.sources++; sourceCount++;
    if (Math.abs(s.price - c.reference) / Math.abs(c.reference) <= 0.01) matched++;
  }
}
const pct = (n, d) => d ? `${(100 * n / d).toFixed(2)}%` : 'n/a (no denominator)';
const wilson = (successes, total) => {
  if (!total) return 'n/a';
  const z = 1.96, p = successes / total, den = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / den;
  const radius = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / den;
  return `[${(100 * (center - radius)).toFixed(2)}%, ${(100 * (center + radius)).toFixed(2)}%]`;
};
const lines = [
  '# Feed quality validation report', '',
  `Generated: ${new Date().toISOString()}`, '',
  '> Corpus results are synthetic validation measurements, not observed production feed performance. Freshness cannot be measured because this corpus contains no timestamped observations.', '',
  '## Coverage and accuracy', '',
  `- Labeled cases: ${corpus.cases.length}; sources: ${sourceCount}; regimes: ${[...regimes.keys()].join(', ')}.`,
  `- Source coverage against the corpus reference within 1%: ${matched}/${sourceCount} (${pct(matched, sourceCount)}).`,
  `- Mean absolute percentage error across labeled sources: ${(errorTotal / sourceCount).toFixed(3)}%.`,
  '- Freshness: unavailable (no observation timestamps in corpus).', '',
  '## Detection quality', '',
  'Detection rule: flag each source whose absolute deviation from the case median exceeds 10%.',
  `- Confusion counts: TP ${tp}, FP ${fp}, FN ${fn}, TN ${tn}.`,
  `- False-positive rate: ${pct(fp, fp + tn)} (95% Wilson CI ${wilson(fp, fp + tn)}); missed-detection rate: ${pct(fn, fn + tp)} (95% Wilson CI ${wilson(fn, fn + tp)}).`,
  '- Coverage within 1%: 95% Wilson CI ' + wilson(matched, sourceCount) + '. Raw counts are shown so small-sample uncertainty is visible.', '',
  '## Results by market regime', '',
  '| Regime | Cases | Sources | Mean absolute error |', '|---|---:|---:|---:|',
  ...[...regimes].map(([name, s]) => `| ${name} | ${s.cases} | ${s.sources} | ${(s.error / s.sources).toFixed(3)}% |`), '',
  '## Methodology and limitations', '', corpus.methodology, '',
  'The corpus is intentionally small and hand-labeled. Results do not establish live coverage, provider independence, liquidity, temporal freshness, or production confidence intervals. Add timestamped independently sourced observations and increase sample size before using this report to compare providers.',
];
const output = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${lines.join('\n')}\n`); }
else process.stdout.write(lines.join('\n'));
