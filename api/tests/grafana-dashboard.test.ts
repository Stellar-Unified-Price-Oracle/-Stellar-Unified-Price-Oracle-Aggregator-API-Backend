import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Grafana Dashboard', () => {
  const dashboardPath = path.join(__dirname, '../../monitoring/grafana-dashboard.json');

  it('should have valid dashboard JSON file', () => {
    expect(fs.existsSync(dashboardPath)).toBe(true);
  });

  it('should parse dashboard JSON correctly', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('should have required dashboard fields', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    expect(dashboard).toHaveProperty('title');
    expect(dashboard).toHaveProperty('panels');
    expect(dashboard).toHaveProperty('schemaVersion');
    expect(dashboard).toHaveProperty('annotations');
    expect(dashboard).toHaveProperty('time');
  });

  it('should have correct dashboard title', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);
    expect(dashboard.title).toBe('Stellar Oracle Monitoring Dashboard');
  });

  it('should include all required monitoring panels', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    expect(dashboard.panels).toHaveLength(7);

    const panelTitles = dashboard.panels.map((p: any) => p.title);
    expect(panelTitles).toContain('Source Health Status');
    expect(panelTitles).toContain('Price Trends');
    expect(panelTitles).toContain('Request Latency (p95, p99)');
    expect(panelTitles).toContain('Circuit Breaker States');
    expect(panelTitles).toContain('Error Rates');
    expect(panelTitles).toContain('Cache Hit Ratio');
    expect(panelTitles).toContain('Soroban Contract Interactions');
  });

  it('should have source health panel with correct metrics', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    const sourceHealthPanel = dashboard.panels.find((p: any) => p.title === 'Source Health Status');
    expect(sourceHealthPanel).toBeDefined();
    expect(sourceHealthPanel.targets).toBeDefined();
    expect(sourceHealthPanel.targets[0].expr).toBe('oracle_source_health{job="aggregator"}');
  });

  it('should have price trends panel with correct metrics', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    const pricePanel = dashboard.panels.find((p: any) => p.title === 'Price Trends');
    expect(pricePanel).toBeDefined();
    expect(pricePanel.targets[0].expr).toBe('oracle_price_usd{job="aggregator"}');
  });

  it('should have latency panel with percentile metrics', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    const latencyPanel = dashboard.panels.find((p: any) => p.title === 'Request Latency (p95, p99)');
    expect(latencyPanel).toBeDefined();
    expect(latencyPanel.targets).toHaveLength(2);
    expect(latencyPanel.targets[0].expr).toContain('0.95');
    expect(latencyPanel.targets[1].expr).toContain('0.99');
  });

  it('should have circuit breaker panel', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    const cbPanel = dashboard.panels.find((p: any) => p.title === 'Circuit Breaker States');
    expect(cbPanel).toBeDefined();
    expect(cbPanel.type).toBe('piechart');
    expect(cbPanel.targets[0].expr).toBe('oracle_circuit_breaker_state{job="aggregator"}');
  });

  it('should have error rates panel', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    const errorPanel = dashboard.panels.find((p: any) => p.title === 'Error Rates');
    expect(errorPanel).toBeDefined();
    expect(errorPanel.targets[0].expr).toContain('oracle_source_errors_total');
  });

  it('should have cache hit ratio panel with thresholds', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    const cachePanel = dashboard.panels.find((p: any) => p.title === 'Cache Hit Ratio');
    expect(cachePanel).toBeDefined();
    expect(cachePanel.type).toBe('gauge');
    expect(cachePanel.fieldConfig.defaults.unit).toBe('percent');
  });

  it('should have Soroban contract interactions panel', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    const sorobanPanel = dashboard.panels.find((p: any) => p.title === 'Soroban Contract Interactions');
    expect(sorobanPanel).toBeDefined();
    expect(sorobanPanel.targets).toHaveLength(2);
    expect(sorobanPanel.targets[0].expr).toContain('soroban_contract_invocations_total');
    expect(sorobanPanel.targets[1].expr).toContain('soroban_contract_errors_total');
  });

  it('should have proper dashboard tags', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    expect(dashboard.tags).toContain('oracle');
    expect(dashboard.tags).toContain('monitoring');
    expect(dashboard.tags).toContain('soroban');
  });

  it('should have all panels with datasource Prometheus', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    dashboard.panels.forEach((panel: any) => {
      expect(panel.datasource).toBe('Prometheus');
      expect(panel.targets).toBeDefined();
      expect(panel.targets.length).toBeGreaterThan(0);
    });
  });

  it('should have proper grid layout', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    dashboard.panels.forEach((panel: any) => {
      expect(panel.gridPos).toBeDefined();
      expect(panel.gridPos.h).toBeGreaterThan(0);
      expect(panel.gridPos.w).toBeGreaterThan(0);
      expect(panel.gridPos.x).toBeGreaterThanOrEqual(0);
      expect(panel.gridPos.y).toBeGreaterThanOrEqual(0);
    });
  });

  it('should have default time range set', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    expect(dashboard.time).toBeDefined();
    expect(dashboard.time.from).toBe('now-6h');
    expect(dashboard.time.to).toBe('now');
  });

  it('should have refresh interval set', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    expect(dashboard.refresh).toBe('30s');
  });

  it('should have valid schema version', () => {
    const raw = fs.readFileSync(dashboardPath, 'utf-8');
    const dashboard = JSON.parse(raw);

    expect(typeof dashboard.schemaVersion).toBe('number');
    expect(dashboard.schemaVersion).toBeGreaterThan(0);
  });
});
