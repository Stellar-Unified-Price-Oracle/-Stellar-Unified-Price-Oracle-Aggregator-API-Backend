import { readFileSync } from 'fs';
import { reviewProviderCutover } from '../services/aggregator/src/oracle-sources/cutover-readiness';

const file = process.argv[2];
if (!file) throw new Error('Usage: tsx scripts/review-provider-cutover.ts EVIDENCE.json');
try {
  const result = reviewProviderCutover(JSON.parse(readFileSync(file, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.allowed ? 0 : 1;
} catch {
  console.error('No-go: unreadable or malformed evidence');
  process.exitCode = 1;
}
