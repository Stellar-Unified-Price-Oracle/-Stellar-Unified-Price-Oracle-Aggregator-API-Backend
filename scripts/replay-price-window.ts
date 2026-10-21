import fs from 'fs';
import { replayAggregation, ReplayPolicy, QualityObservation } from '../services/aggregator/src/price-aggregation/quality';

const [inputPath, asset, startArg, endArg, policyPath] = process.argv.slice(2);
if (!inputPath || !asset || !startArg || !endArg) {
  throw new Error('Usage: npx tsx scripts/replay-price-window.ts <observations.json> <asset> <window-start-seconds> <window-end-seconds> [policy.json]');
}
const observations = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as QualityObservation[];
const policy = policyPath ? JSON.parse(fs.readFileSync(policyPath, 'utf8')) as ReplayPolicy : undefined;
process.stdout.write(`${JSON.stringify(replayAggregation(asset, observations, Number(startArg), Number(endArg), policy), null, 2)}\n`);
