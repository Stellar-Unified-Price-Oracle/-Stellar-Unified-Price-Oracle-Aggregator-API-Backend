#!/usr/bin/env node
// feed-inspect: resolve feed ids, inspect metadata, check freshness, verify connectivity.
// Exit codes: 0 ok, 1 unhealthy (stale/missing/unreachable), 2 usage error.
import { normalizeFeedId, inspectFeed, checkFreshness, checkConnectivity } from './lib.mjs';

const USAGE = `Usage: feed-inspect <command> [options]
  resolve <feed>      Normalize an identifier (xlm-usd -> XLM/USD)
  inspect <feed>      Print feed metadata/latest price from the API
  freshness <feed>    Check data age (--max-age <sec>, default 60)
  check               Verify endpoint connectivity (live/ready)
Options: --url <base> (default $ORACLE_API_URL or http://localhost:3000)
         --timeout <ms> (default 5000)   --json`;

function parse(argv) {
  const args = { _: [], url: process.env.ORACLE_API_URL || 'http://localhost:3000', timeout: 5000, maxAge: 60, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--max-age') args.maxAge = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else args._.push(a);
  }
  if (![args.timeout, args.maxAge].every((n) => Number.isFinite(n) && n > 0)) throw new Error('--timeout and --max-age must be positive numbers');
  args.url = String(args.url).replace(/\/+$/, '');
  return args;
}

async function main() {
  let args;
  try { args = parse(process.argv.slice(2)); } catch (e) { console.error(e.message + '\n' + USAGE); return 2; }
  const [cmd, feed] = args._;
  const out = (obj) => console.log(args.json ? JSON.stringify(obj) : JSON.stringify(obj, null, 2));
  try {
    switch (cmd) {
      case 'resolve': out({ input: feed, feed: normalizeFeedId(feed) }); return 0;
      case 'inspect': {
        const r = await inspectFeed({ baseUrl: args.url, feed, timeoutMs: args.timeout });
        out(r); return r.found ? 0 : 1;
      }
      case 'freshness': {
        const r = await checkFreshness({ baseUrl: args.url, feed, maxAgeSec: args.maxAge, timeoutMs: args.timeout });
        out(r); return r.status === 'fresh' ? 0 : 1;
      }
      case 'check': {
        const r = await checkConnectivity({ baseUrl: args.url, timeoutMs: args.timeout });
        out(r); return r.ok ? 0 : 1;
      }
      default: console.error(USAGE); return 2;
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    return /invalid feed/.test(e.message) ? 2 : 1;
  }
}

process.exitCode = await main();
