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
