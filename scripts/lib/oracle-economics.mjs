/**
 * Shared, deterministic building blocks for the oracle economics simulations
 * (issues #788 and #790).
 *
 * `aggregateRound` mirrors the publication rules in
 * services/aggregator/src/price-aggregation/aggregator.ts and circuit-breaker.ts:
 * every live report is compared with the cross-source median, reports beyond
 * the circuit-breaker deviation are excluded, the median of the remainder is
 * published, and when nothing is trusted the legacy path falls back to all
 * live reports. `contractGuardAccepts` mirrors utils::deviation_exceeds in the
 * Soroban contract, which compares against the last *accepted* price.
 */

export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    bernoulli: (p) => next() < p,
    normal: (mean = 0, sd = 1) => {
      const u = Math.max(next(), Number.EPSILON);
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

export function median(values) {
  if (values.length === 0) throw new Error('median of empty set');
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function errorBps(price, reference) {
  if (reference === 0) throw new Error('reference price must be non-zero');
  return (Math.abs(price - reference) / Math.abs(reference)) * 10_000;
}

export function validatePolicy(policy) {
  if (!policy || !Number.isInteger(policy.minSources) || policy.minSources < 1) {
    throw new Error('aggregation policy requires integer minSources >= 1');
  }
  if (!(policy.circuitBreakerDeviationPct > 0)) {
    throw new Error('aggregation policy requires circuitBreakerDeviationPct > 0');
  }
  return policy;
}

/**
 * @param {Array<{source: string, issuer?: string, price: number|null}>} reports
 *   `price: null` means the source did not report this round.
 * @param {{minSources: number, circuitBreakerDeviationPct: number,
 *   fallbackToSuspicious?: boolean, distinctIssuersOnly?: boolean}} policy
 */
export function aggregateRound(reports, policy) {
  validatePolicy(policy);
  const offline = reports.filter((r) => r.price === null || r.price === undefined).map((r) => r.source);
  let live = reports.filter((r) => r.price !== null && r.price !== undefined);

  if (policy.distinctIssuersOnly) {
    const seen = new Set();
    live = live.filter((r) => {
      const issuer = r.issuer ?? r.source;
      if (seen.has(issuer)) return false;
      seen.add(issuer);
      return true;
    });
  }

  if (live.length < policy.minSources) {
    return { published: false, reason: 'quorum', price: null, included: [], flagged: [], offline };
  }

  const reference = median(live.map((r) => r.price));
  const trusted = [];
  const flagged = [];
  for (const r of live) {
    const deviationPct = (Math.abs(r.price - reference) / Math.abs(reference)) * 100;
    (deviationPct > policy.circuitBreakerDeviationPct ? flagged : trusted).push(r);
  }

  let used = trusted;
  let fallback = false;
  if (trusted.length === 0 && policy.fallbackToSuspicious) {
    used = live;
    fallback = true;
  }
  if (used.length < policy.minSources) {
    return { published: false, reason: 'quorum-after-filter', price: null, included: [], flagged: flagged.map((r) => r.source), offline };
  }

  return {
    published: true,
    reason: fallback ? 'suspicious-fallback' : 'ok',
    price: median(used.map((r) => r.price)),
    included: used.map((r) => r.source),
    flagged: flagged.map((r) => r.source),
    offline,
  };
}

export function contractGuardAccepts(price, lastAccepted, guardBps) {
  if (guardBps === null || guardBps === undefined || lastAccepted === null || lastAccepted === 0) return true;
  return errorBps(price, lastAccepted) <= guardBps;
}

/** Herfindahl-Hirschman index on the 0..10000 scale from non-negative weights. */
export function hhi(weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!(total > 0)) throw new Error('hhi requires a positive total weight');
  if (weights.some((w) => w < 0)) throw new Error('hhi weights must be non-negative');
  return weights.reduce((s, w) => s + ((w / total) * 100) ** 2, 0);
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function money(value) {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '—';
  const formatted = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

export function pct(value, digits = 2) {
  return `${round(value * 100, digits).toFixed(digits)}%`;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * Runs `rounds` publication rounds over a random-walk true price.
 * Attackers report truePrice * (1 + attackShiftBps / 1e4); offline sources report nothing.
 * A round is *available* when it publishes and the contract guard accepts it,
 * and *corrupted* when an accepted price is further than maxTolerableErrorBps from truth.
 */
export function simulateRounds({
  rounds,
  seed,
  sources,
  policy,
  referencePrice,
  honestNoiseBps,
  volatilityBps,
  maxTolerableErrorBps,
  guardBps = null,
  attackers = [],
  attackShiftBps = 0,
  issuers = {},
  outage = null,
}) {
  if (!Number.isInteger(rounds) || rounds <= 0) throw new Error('rounds must be a positive integer');
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('at least one source is required');
  if (!(referencePrice > 0)) throw new Error('referencePrice must be positive');
  for (const a of attackers) {
    if (!sources.includes(a)) throw new Error(`attacker ${a} is not a configured source`);
  }
  validatePolicy(policy);

  const rng = createRng(seed);
  const attackerSet = new Set(attackers);
  const honest = sources.filter((s) => !attackerSet.has(s));
  const included = Object.fromEntries(sources.map((s) => [s, 0]));
  const missed = Object.fromEntries(sources.map((s) => [s, 0]));
  const soloMissed = Object.fromEntries(sources.map((s) => [s, 0]));
  const groupOf = {};
  if (outage) {
    for (const [group, members] of Object.entries(outage.groups ?? {})) {
      for (const m of members) groupOf[m] = group;
    }
  }

  let truth = referencePrice;
  let lastAccepted = null;
  let available = 0;
  let corrupted = 0;
  let honestFlags = 0;
  let jointMissRounds = 0;
  let streak = 0;
  let maxStreak = 0;
  const errors = [];

  for (let i = 0; i < rounds; i++) {
    truth *= 1 + rng.normal(0, volatilityBps / 10_000);
    const downGroups = new Set();
    if (outage) {
      for (const group of Object.keys(outage.groups ?? {})) {
        if (rng.bernoulli(outage.groupProbability ?? 0)) downGroups.add(group);
      }
    }
    const reports = sources.map((source) => {
      const down = outage && (downGroups.has(groupOf[source]) || rng.bernoulli(outage.independentProbability ?? 0));
      if (down) return { source, issuer: issuers[source], price: null };
      const price = attackerSet.has(source)
        ? truth * (1 + attackShiftBps / 10_000)
        : truth * (1 + rng.normal(0, honestNoiseBps / 10_000));
      return { source, issuer: issuers[source], price };
    });

    const result = aggregateRound(reports, policy);
    for (const s of result.offline) missed[s]++;
    if (result.offline.length >= 2) jointMissRounds++;
    if (result.offline.length === 1) soloMissed[result.offline[0]]++;
    honestFlags += result.flagged.filter((s) => !attackerSet.has(s)).length;

    const accepted = result.published && contractGuardAccepts(result.price, lastAccepted, guardBps);
    if (accepted) {
      lastAccepted = result.price;
      available++;
      streak = 0;
      for (const s of result.included) included[s]++;
      const e = errorBps(result.price, truth);
      errors.push(e);
      if (e > maxTolerableErrorBps) corrupted++;
    } else {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    }
  }

  const sortedErrors = errors.sort((x, y) => x - y);
  const corruptErrors = sortedErrors.filter((e) => e > maxTolerableErrorBps);
  return {
    rounds,
    availability: available / rounds,
    corruptionRate: corrupted / rounds,
    meanErrorBps: sortedErrors.length ? sortedErrors.reduce((s, e) => s + e, 0) / sortedErrors.length : 0,
    p99ErrorBps: quantile(sortedErrors, 0.99),
    meanCorruptErrorBps: corruptErrors.length ? corruptErrors.reduce((s, e) => s + e, 0) / corruptErrors.length : 0,
    honestFlagRate: honest.length ? honestFlags / (rounds * honest.length) : 0,
    maxConsecutiveUnavailable: maxStreak,
    jointMissRate: jointMissRounds / rounds,
    inclusionRate: Object.fromEntries(sources.map((s) => [s, included[s] / rounds])),
    missRate: Object.fromEntries(sources.map((s) => [s, missed[s] / rounds])),
    soloMissRate: Object.fromEntries(sources.map((s) => [s, soloMissed[s] / rounds])),
  };
}

/** First sweep row (in order) for which `fails(row)` is true, or null. */
export function firstFailure(rows, fails) {
  return rows.find(fails) ?? null;
}
