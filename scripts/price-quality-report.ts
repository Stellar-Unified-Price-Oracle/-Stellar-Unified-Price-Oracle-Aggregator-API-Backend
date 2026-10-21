import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadCorpus, predictionSchema, scoreWindow, backtestFreshness } from '../services/aggregator/src/price-quality/benchmark';

const [predictionsPath, outputPath] = process.argv.slice(2);
if (!predictionsPath || !outputPath) throw new Error('Usage: npm run quality:report -- predictions.jsonl report.json');
const root = new URL('../benchmarks/price-quality/v1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const references = loadCorpus(readFileSync(new URL('references.jsonl', root), 'utf8'), manifest);
const raw = readFileSync(predictionsPath, 'utf8');
const predictions = raw.trim() ? raw.trim().split('\n').map(line => predictionSchema.parse(JSON.parse(line))) : [];
const split = 1735776000;
const report = {
  corpusVersion: manifest.version, corpusSha256: manifest.sha256,
  predictionsSha256: createHash('sha256').update(raw).digest('hex'),
  interpretation: 'Observed source-count-ratio score bands, not probability guarantees. 100 bps is a review budget, not a validated SLA. No matched production outputs means no production calibration claim.',
  calibration2024: scoreWindow(references, predictions, manifest.start, split),
  heldOut2025: scoreWindow(references, predictions, split, manifest.end),
  perAsset: Object.fromEntries(['BTC', 'ETH'].map(asset => {
    const refs = references.filter(r => r.asset === asset);
    const outputs = predictions.filter(p => p.asset === asset);
    return [asset, { calibration2024: scoreWindow(refs, outputs, manifest.start, split),
      heldOut2025: scoreWindow(refs, outputs, split, manifest.end) }];
  })),
  freshness: backtestFreshness(references, { minAgeMs: 5000, baseAgeMs: 30000, hardMaxAgeMs: 60000, sensitivity: 10 }),
};
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
const curveRows = ['asset,window,lower,upper,count,meanConfidence,meanErrorBps,p95ErrorBps,withinBoundRate,wilsonLower95,status'];
for (const [asset, windows] of [['ALL', report], ...Object.entries(report.perAsset)] as const) {
  for (const [name, window] of [['calibration2024', windows.calibration2024], ['heldOut2025', windows.heldOut2025]] as const) {
    for (const bin of window.curve) curveRows.push([asset, name, bin.lower, bin.upper, bin.count, bin.meanConfidence,
      bin.meanErrorBps, bin.p95ErrorBps, bin.withinBoundRate, bin.wilsonLower95, bin.status].join(','));
  }
}
writeFileSync(outputPath + '.curves.csv', curveRows.join('\n') + '\n');
