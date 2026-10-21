import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = (await readFile(path.join(root, 'verification/fixtures/price-arithmetic-vectors.tsv'), 'utf8'))
  .split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(/\s+/));
const pow10 = (n) => { if (!Number.isInteger(n) || n < 0 || n > 38) throw new RangeError('decimal exponent outside 0..38'); return 10n ** BigInt(n); };
const MIN = -(1n << 127n), MAX = (1n << 127n) - 1n;
const checked = (n) => { if (n < MIN || n > MAX) throw new RangeError('i128 overflow'); return n; };
function convert(amount, amountDecimals, rate, rateDecimals, outputDecimals) {
  const exponent = outputDecimals - amountDecimals - rateDecimals;
  let numerator = checked(BigInt(amount) * BigInt(rate)), denominator = 1n;
  if (exponent >= 0) numerator = checked(numerator * pow10(exponent)); else denominator = pow10(-exponent);
  const quotient = numerator / denominator, remainder = numerator % denominator;
  return checked(quotient + (remainder !== 0n && 2n * (remainder < 0n ? -remainder : remainder) >= denominator ? (numerator < 0n ? -1n : 1n) : 0n));
}
const failures = [];
for (const [name, a, ad, r, rd, od, expected] of rows) {
  try { const actual = convert(a, Number(ad), r, Number(rd), Number(od)); if (actual !== BigInt(expected)) failures.push(`${name}: ${actual} != ${expected}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); }
}
try { convert('170141183460469231731687303715884105727', 0, 10, 0, 1); failures.push('overflow vector unexpectedly succeeded'); }
catch (error) { if (!(error instanceof RangeError)) failures.push(`unexpected overflow behavior: ${error.message}`); }
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`Price arithmetic vectors: ${rows.length} passed; overflow boundary passed.`);
