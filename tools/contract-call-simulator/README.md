# Consumer contract-call simulator

Owner: Developer ecosystem and integration. A zero-dependency local simulator for common Soroban consumer reads, so integrators can test handling of bad oracle states without a network.

```js
import { OracleSimulator } from './simulator.mjs';
const sim = new OracleSimulator({ maxAgeSeconds: 300 });
sim.setFeed('XLM/USD', { state: 'stale' });
try { sim.safePrice('XLM/USD'); } catch (e) { console.log(e.code); } // STALE
```

## States
| State | `lastprice` | `safePrice` error |
|---|---|---|
| `fresh` | price + timestamp | none |
| `stale` | old timestamp (or `ageSeconds`) | `STALE` |
| `paused` | throws | `PAUSED` |
| `missing` | `null` | `MISSING` |
| `malformed` | non-positive price, bad decimals | `MALFORMED` |

`setPaused(bool)` pauses the whole contract independent of feed state.

## Tests
`node --test tools/contract-call-simulator` covers fresh, the max-age boundary, and each failure state.

## Operations
Dev-time tool only: not deployed, no production impact, no dependency on repo build. Behaviour mirrors consumer-visible semantics; verify against testnet before release. Rollback: delete the directory.
