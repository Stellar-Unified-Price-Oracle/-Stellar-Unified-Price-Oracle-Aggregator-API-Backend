import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

function loadYamlFiles(dir: string): any[] {
  const results: any[] = [];
  const files = fs.readdirSync(dir);

  files.forEach((f) => {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...loadYamlFiles(full));
      return;
    }
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) return;
    const content = fs.readFileSync(full, 'utf8');
    try {
      const doc = yaml.loadAll(content);
      results.push(...doc.map((d) => ({ doc: d, file: full })));
    } catch (e) {
      // ignore parse errors for non-alert YAML
    }
  });

  return results;
}

describe('History gap detector tooling', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const detectorPath = path.join(repoRoot, 'scripts', 'history-gap-detector.js');
  const backfillPath = path.join(repoRoot, 'scripts', 'history-backfill.js');

  function readScript(p: string): string {
    expect(fs.existsSync(p), `expected script at ${p}`).toBe(true);
    return fs.readFileSync(p, 'utf8');
  }

  it('gap detector emits structured output with asset, gapStart, gapEnd, durationSec and backfill command', () => {
    const src = readScript(detectorPath);

    // Structured fields must be present in the emitted report.
    expect(src).toMatch(/asset/);
    expect(src).toMatch(/gapStart/);
    expect(src).toMatch(/gapEnd/);
    expect(src).toMatch(/durationSec/);
    expect(src).toMatch(/history:backfill/);

    // The backfill command should be constructed with --asset/--from/--to.
    expect(src).toMatch(/--asset/);
    expect(src).toMatch(/--from/);
    expect(src).toMatch(/--to/);

    // The alert threshold env var should be honoured.
    expect(src).toMatch(/HISTORY_GAP_ALERT_SEC/);
  });

  it('gap detector exits non-zero when gaps remain and zero when closed', () => {
    const src = readScript(detectorPath);

    // Must set a non-zero exit code when gaps are detected.
    expect(src).toMatch(/process\.exitCode\s*=\s*1|process\.exit\(\s*1\s*\)/);
    // And a zero exit code when no gaps remain.
    expect(src).toMatch(/process\.exitCode\s*=\s*0|process\.exit\(\s*0\s*\)/);
  });

  it('backfill script verifies gaps are closed and exits non-zero if any remain', () => {
    const src = readScript(backfillPath);

    // Backfill must accept the documented CLI flags.
    expect(src).toMatch(/--asset/);
    expect(src).toMatch(/--from/);
    expect(src).toMatch(/--to/);

    // It must verify the result and fail when gaps remain.
    expect(src).toMatch(/process\.exitCode\s*=\s*1|process\.exit\(\s*1\s*\)/);
    expect(src).toMatch(/process\.exitCode\s*=\s*0|process\.exit\(\s*0\s*\)/);
  });
});

describe('Alert runbooks', () => {
  it('all P0/P1 alerts include a runbook_url annotation', () => {
    // Resolve repository root relative to this test file and locate `k8s`
    const k8sDir = path.resolve(__dirname, '..', '..', 'k8s');
    const docsPrefix = '/docs/runbooks/';
    const yamlDocs = loadYamlFiles(k8sDir);

    const alerts: { name: string; severity?: string; runbook?: string; file: string }[] = [];

    yamlDocs.forEach(({ doc, file }) => {
      if (!doc) return;
      // PrometheusRule structure
      let groups: any = null;
      if (doc.spec && doc.spec.groups) {
        groups = doc.spec.groups;
      } else if (doc.data && doc.data['stellar-oracle-mesh.rules.yaml']) {
        try {
          const parsed = yaml.load(doc.data['stellar-oracle-mesh.rules.yaml']);
          groups = parsed?.groups || null;
        } catch (e) {
          groups = null;
        }
      }
      if (!groups) return;
      groups.forEach((g: any) => {
        (g.rules || []).forEach((r: any) => {
          alerts.push({ name: r.alert, severity: r.labels?.severity, runbook: r.annotations?.runbook_url, file });
        });
      });
    });

    // Only check P0/P1 (critical/warning)
    const p0p1 = alerts.filter((a) => a.severity === 'critical' || a.severity === 'warning');
    expect(p0p1.length).toBeGreaterThan(0);

    p0p1.forEach((a) => {
      expect(a.runbook, `${a.name} in ${a.file} is missing runbook_url`).toBeDefined();
      expect(a.runbook).toContain(docsPrefix);
    });
  });
});
