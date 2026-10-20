import { loadConfig } from './config.mjs';
import { createClient, OracleError } from './client.mjs';

const cfg = loadConfig();
const client = createClient(cfg);
const asset = process.argv[2] ?? 'XLM';
try {
  console.log('sources:', JSON.stringify(await client.discoverSources()));
  const p = await client.getPrice(asset);
  console.log(`${asset} = ${p.value} (decimals ${p.decimals}, source ${p.source})`);
} catch (e) {
  if (e instanceof OracleError) { console.error(`oracle error ${e.code} (${e.status}): ${e.message}`); process.exit(1); }
  throw e;
}
