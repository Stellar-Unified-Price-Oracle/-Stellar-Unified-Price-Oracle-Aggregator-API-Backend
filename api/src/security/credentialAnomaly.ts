import { createHash } from 'crypto';

/**
 * Anomalous credential usage detector. Standalone and pluggable: call
 * `detector.observe(event)` from any auth path. Raw secrets are never accepted
 * or stored; credentials are identified by an opaque key id which is hashed
 * before being used as a map key or emitted in alerts.
 */

export type AnomalyKind = 'new_geography' | 'new_endpoint_pattern' | 'privilege_escalation' | 'usage_spike';

export interface CredentialEvent {
  /** Opaque credential identifier (key id/prefix). Never pass the secret itself. */
  credentialId: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** ISO country code or other coarse geography label; undefined if unknown. */
  country?: string;
  /** Route template (e.g. /api/v2/prices/:asset), not a raw URL with identifiers. */
  endpoint: string;
  /** Role or scope used for this request (e.g. 'read', 'admin'). */
  privilege: string;
}

export interface AnomalyAlert {
  kind: AnomalyKind;
  /** Short SHA-256 of the credential id; safe to log. */
  credentialRef: string;
  timestamp: number;
  detail: string;
}

export interface DetectorOptions {
  /** Events needed per credential before alerts are raised. Default 20. */
  warmupEvents?: number;
  /** Window for rate comparison. Default 60_000 ms. */
  windowMs?: number;
  /** Current window count must exceed baseline * spikeFactor. Default 5. */
  spikeFactor?: number;
  /** Minimum absolute count in window to call a spike. Default 30. */
  spikeMinCount?: number;
  /** Max distinct credentials tracked (oldest evicted). Default 10_000. */
  maxCredentials?: number;
  /** Privilege ranking, low to high. Default read < write < admin. */
  privilegeOrder?: string[];
}

interface State {
  events: number;
  countries: Set<string>;
  endpoints: Set<string>;
  maxPrivilege: number;
  windowStart: number;
  windowCount: number;
  baselineRate: number; // events per window, exponentially smoothed
}

export function credentialRef(credentialId: string): string {
  return createHash('sha256').update(credentialId).digest('hex').slice(0, 12);
}

export class CredentialAnomalyDetector {
  private readonly states = new Map<string, State>();
  private readonly o: Required<DetectorOptions>;

  constructor(options: DetectorOptions = {}) {
    this.o = {
      warmupEvents: options.warmupEvents ?? 20,
      windowMs: options.windowMs ?? 60_000,
      spikeFactor: options.spikeFactor ?? 5,
      spikeMinCount: options.spikeMinCount ?? 30,
      maxCredentials: options.maxCredentials ?? 10_000,
      privilegeOrder: options.privilegeOrder ?? ['read', 'write', 'admin'],
    };
  }

  private rank(p: string): number {
    const i = this.o.privilegeOrder.indexOf(p);
    return i < 0 ? 0 : i;
  }

  observe(ev: CredentialEvent): AnomalyAlert[] {
    const ref = credentialRef(ev.credentialId);
    const alerts: AnomalyAlert[] = [];
    const alert = (kind: AnomalyKind, detail: string) => alerts.push({ kind, credentialRef: ref, timestamp: ev.timestamp, detail });

    let s = this.states.get(ref);
    if (!s) {
      if (this.states.size >= this.o.maxCredentials) {
        const oldest = this.states.keys().next().value;
        if (oldest !== undefined) this.states.delete(oldest);
      }
      s = { events: 0, countries: new Set(), endpoints: new Set(), maxPrivilege: 0, windowStart: ev.timestamp, windowCount: 0, baselineRate: 0 };
      this.states.set(ref, s);
    }

    // Roll the rate window.
    if (ev.timestamp - s.windowStart >= this.o.windowMs) {
      const elapsedWindows = Math.max(1, Math.floor((ev.timestamp - s.windowStart) / this.o.windowMs));
      // Only the first elapsed window had traffic; the rest were empty.
      s.baselineRate = s.baselineRate === 0 ? s.windowCount : 0.7 * s.baselineRate + 0.3 * s.windowCount;
      for (let i = 1; i < elapsedWindows && i < 5; i++) s.baselineRate *= 0.7;
      s.windowStart = ev.timestamp;
      s.windowCount = 0;
    }
    s.windowCount += 1;
    s.events += 1;
    const warmed = s.events > this.o.warmupEvents;

    if (warmed) {
      if (ev.country && s.countries.size > 0 && !s.countries.has(ev.country)) {
        alert('new_geography', `first use from country ${ev.country}; ${s.countries.size} known`);
      }
      if (!s.endpoints.has(ev.endpoint)) {
        alert('new_endpoint_pattern', `first use of endpoint ${ev.endpoint}`);
      }
      if (this.rank(ev.privilege) > s.maxPrivilege) {
        alert('privilege_escalation', `privilege ${ev.privilege} exceeds previously used level`);
      }
      if (s.baselineRate > 0 && s.windowCount >= this.o.spikeMinCount && s.windowCount > s.baselineRate * this.o.spikeFactor) {
        alert('usage_spike', `${s.windowCount} requests in window vs baseline ~${s.baselineRate.toFixed(1)}`);
      }
    }

    // Learn after evaluating (and always during warmup).
    if (ev.country) s.countries.add(ev.country);
    s.endpoints.add(ev.endpoint);
    s.maxPrivilege = Math.max(s.maxPrivilege, this.rank(ev.privilege));
    return alerts;
  }

  /** Forget a credential (e.g. on revocation/rotation). */
  reset(credentialId: string): void {
    this.states.delete(credentialRef(credentialId));
  }
}
