export type ComponentStatus = 'operational' | 'degraded' | 'down';

export interface Component {
  name: string;
  status: ComponentStatus;
  uptimePercent: number;
  lastCheckedAt: number;
}

export interface Incident {
  id: string;
  title: string;
  component: string;
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  severity: 'minor' | 'major' | 'critical';
  startedAt: number;
  resolvedAt: number | null;
  updates: { message: string; timestamp: number }[];
}

interface CheckRecord {
  timestamp: number;
  ok: boolean;
}

const WINDOW_SIZE = 1440; // keep 24 h of per-minute checks

class ComponentTracker {
  private checks: CheckRecord[] = [];
  status: ComponentStatus = 'operational';
  lastCheckedAt = 0;

  record(ok: boolean): void {
    const now = Date.now();
    this.checks.push({ timestamp: now, ok });
    if (this.checks.length > WINDOW_SIZE) this.checks.shift();
    this.lastCheckedAt = Math.floor(now / 1000);
    this.status = ok ? 'operational' : 'down';
  }

  get uptimePercent(): number {
    if (this.checks.length === 0) return 100;
    const ok = this.checks.filter((c) => c.ok).length;
    return Math.round((ok / this.checks.length) * 10000) / 100;
  }
}

class UptimeTracker {
  private components: Map<string, ComponentTracker> = new Map();
  private incidents: Incident[] = [];
  private incidentCounter = 0;

  private getOrCreate(name: string): ComponentTracker {
    if (!this.components.has(name)) this.components.set(name, new ComponentTracker());
    return this.components.get(name)!;
  }

  recordCheck(name: string, ok: boolean): void {
    const tracker = this.getOrCreate(name);
    const wasOk = tracker.status === 'operational';
    tracker.record(ok);

    if (wasOk && !ok) {
      this.openIncident(name, `${name} is unreachable`);
    } else if (!wasOk && ok) {
      this.resolveIncident(name);
    }
  }

  setDegraded(name: string): void {
    const tracker = this.getOrCreate(name);
    tracker.status = 'degraded';
    tracker.lastCheckedAt = Math.floor(Date.now() / 1000);
  }

  getComponents(): Component[] {
    const result: Component[] = [];
    for (const [name, t] of this.components.entries()) {
      result.push({
        name,
        status: t.status,
        uptimePercent: t.uptimePercent,
        lastCheckedAt: t.lastCheckedAt,
      });
    }
    return result;
  }

  getIncidents(limit = 20): Incident[] {
    return this.incidents.slice(-limit).reverse();
  }

  private openIncident(component: string, title: string): void {
    this.incidentCounter++;
    const incident: Incident = {
      id: `INC-${String(this.incidentCounter).padStart(4, '0')}`,
      title,
      component,
      status: 'investigating',
      severity: 'major',
      startedAt: Math.floor(Date.now() / 1000),
      resolvedAt: null,
      updates: [{ message: 'Incident opened — investigating.', timestamp: Math.floor(Date.now() / 1000) }],
    };
    this.incidents.push(incident);
    if (this.incidents.length > 100) this.incidents.shift();
  }

  private resolveIncident(component: string): void {
    const open = [...this.incidents]
      .reverse()
      .find((i) => i.component === component && i.resolvedAt === null);
    if (open) {
      open.status = 'resolved';
      open.resolvedAt = Math.floor(Date.now() / 1000);
      open.updates.push({ message: 'Service recovered. Incident resolved.', timestamp: Math.floor(Date.now() / 1000) });
    }
  }

  overallStatus(): ComponentStatus {
    const statuses = [...this.components.values()].map((t) => t.status);
    if (statuses.some((s) => s === 'down')) return 'down';
    if (statuses.some((s) => s === 'degraded')) return 'degraded';
    return 'operational';
  }
}

export const uptimeTracker = new UptimeTracker();
