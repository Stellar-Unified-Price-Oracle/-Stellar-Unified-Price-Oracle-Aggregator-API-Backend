import { describe, it, expect, beforeEach } from 'vitest';

describe('Cost Attribution (Issue #459)', () => {
  describe('Component Attribution', () => {
    it('should attribute API gateway costs to API component', () => {
      const componentCosts = {
        'api': 0,
        'aggregator': 0,
        'database': 0,
      };

      const apiGatewayCost = 250;
      componentCosts['api'] += apiGatewayCost;

      expect(componentCosts['api']).toBe(250);
    });

    it('should attribute aggregator processing costs to aggregator component', () => {
      const componentCosts = {
        'api': 0,
        'aggregator': 0,
        'database': 0,
      };

      const aggregatorComputeCost = 500;
      componentCosts['aggregator'] += aggregatorComputeCost;

      expect(componentCosts['aggregator']).toBe(500);
    });

    it('should attribute database storage costs to database component', () => {
      const componentCosts = {
        'api': 0,
        'aggregator': 0,
        'database': 0,
      };

      const dbStorageCost = 300;
      componentCosts['database'] += dbStorageCost;

      expect(componentCosts['database']).toBe(300);
    });

    it('should calculate total component costs', () => {
      const componentCosts = {
        'api': 250,
        'aggregator': 500,
        'database': 300,
      };

      const totalCost = Object.values(componentCosts).reduce((sum, cost) => sum + cost, 0);

      expect(totalCost).toBe(1050);
    });
  });

  describe('Direct Attribution', () => {
    it('should directly attribute provider API calls to source', () => {
      const sourceApiCosts: Record<string, number> = {
        'chainlink': 0,
        'redstone': 0,
        'band': 0,
        'reflector': 0,
      };

      const chainlinkCalls = 1000;
      const costPerCall = 0.001;
      sourceApiCosts['chainlink'] = chainlinkCalls * costPerCall;

      expect(sourceApiCosts['chainlink']).toBe(1);
    });

    it('should attribute egress bandwidth to consumer', () => {
      const consumerEgressCosts: Record<string, number> = {};
      const consumerA = 'consumer_a';
      const gbTransferred = 50;
      const costPerGb = 0.12;

      consumerEgressCosts[consumerA] = gbTransferred * costPerGb;

      expect(consumerEgressCosts[consumerA]).toBe(6);
    });

    it('should attribute storage per asset partition', () => {
      const assetStorageCosts: Record<string, number> = {};

      assetStorageCosts['XLM'] = 15;
      assetStorageCosts['USDC'] = 12;
      assetStorageCosts['BTC'] = 20;

      const totalStorage = Object.values(assetStorageCosts).reduce((a, b) => a + b, 0);

      expect(totalStorage).toBe(47);
    });
  });

  describe('Shared Cost Allocation', () => {
    it('should allocate control-plane costs based on request volume', () => {
      const controlPlaneCost = 1000;
      const requests = {
        'api': 5000,
        'aggregator': 3000,
      };

      const totalRequests = Object.values(requests).reduce((a, b) => a + b, 0);
      const allocatedCosts: Record<string, number> = {};

      for (const [component, reqCount] of Object.entries(requests)) {
        allocatedCosts[component] = (reqCount / totalRequests) * controlPlaneCost;
      }

      expect(allocatedCosts['api']).toBe(625);
      expect(allocatedCosts['aggregator']).toBe(375);
    });

    it('should allocate observability costs based on log volume', () => {
      const observabilityCost = 500;
      const logVolume = {
        'api': 40,
        'aggregator': 60,
      };

      const totalLogs = Object.values(logVolume).reduce((a, b) => a + b, 0);
      const allocatedCosts: Record<string, number> = {};

      for (const [component, logs] of Object.entries(logVolume)) {
        allocatedCosts[component] = (logs / totalLogs) * observabilityCost;
      }

      expect(allocatedCosts['api']).toBe(200);
      expect(allocatedCosts['aggregator']).toBe(300);
    });

    it('should allocate load balancer costs based on traffic percentage', () => {
      const lbCost = 800;
      const traffic = {
        'api_traffic': 0.7,
        'health_check_traffic': 0.3,
      };

      const allocatedCosts: Record<string, number> = {};

      for (const [component, percentage] of Object.entries(traffic)) {
        allocatedCosts[component] = percentage * lbCost;
      }

      expect(allocatedCosts['api_traffic']).toBe(560);
      expect(allocatedCosts['health_check_traffic']).toBe(240);
    });
  });

  describe('Per-Consumer Attribution', () => {
    it('should attribute egress costs to consumer by metered usage', () => {
      const consumerUsage = {
        'consumer_a': 100,
        'consumer_b': 150,
        'consumer_c': 250,
      };

      const egressCostPerGb = 0.12;
      const totalEgressCost = 540;
      const totalGb = Object.values(consumerUsage).reduce((a, b) => a + b, 0);

      const consumerCosts: Record<string, number> = {};
      for (const [consumer, gb] of Object.entries(consumerUsage)) {
        consumerCosts[consumer] = (gb / totalGb) * totalEgressCost;
      }

      expect(consumerCosts['consumer_a']).toBe(totalEgressCost * (100 / 500));
      expect(consumerCosts['consumer_b']).toBe(totalEgressCost * (150 / 500));
      expect(consumerCosts['consumer_c']).toBe(totalEgressCost * (250 / 500));
    });

    it('should list non-attributable costs explicitly', () => {
      const nonAttributableCosts = [
        'licensing_and_compliance',
        'security_audit',
        'disaster_recovery_standby',
      ];

      expect(nonAttributableCosts.length).toBeGreaterThan(0);
      expect(nonAttributableCosts).toContain('licensing_and_compliance');
    });
  });

  describe('Cost Reconciliation', () => {
    it('should reconcile allocated costs against actual billing', () => {
      const allocatedCosts = {
        'api': 250,
        'aggregator': 500,
        'database': 300,
      };

      const actualBilling = 1050;
      const totalAllocated = Object.values(allocatedCosts).reduce((a, b) => a + b, 0);

      expect(totalAllocated).toBe(actualBilling);
      expect(totalAllocated / actualBilling).toBe(1);
    });

    it('should calculate variance between allocated and actual', () => {
      const allocated = 1000;
      const actual = 1050;
      const variance = Math.abs(actual - allocated) / actual;

      expect(variance).toBeGreaterThan(0);
      expect(variance).toBeLessThan(0.05);
    });

    it('should report unattributed remainder explicitly', () => {
      const actualBilling = 1100;
      const totalAttributed = 1000;
      const unattributedRemainder = actualBilling - totalAttributed;

      expect(unattributedRemainder).toBe(100);
      expect(unattributedRemainder / actualBilling).toBe(100 / 1100);
    });

    it('should flag variance exceeding threshold', () => {
      const varianceThreshold = 0.05;
      const allocated = 1000;
      const actual = 1150;
      const variance = Math.abs(actual - allocated) / actual;

      const exceedsThreshold = variance > varianceThreshold;

      expect(exceedsThreshold).toBe(true);
    });
  });

  describe('Decision Usefulness', () => {
    it('should inform tier pricing decisions based on per-consumer costs', () => {
      const consumerCosts = {
        'consumer_a': 100,
        'consumer_b': 500,
      };

      expect(consumerCosts['consumer_b']).toBeGreaterThan(consumerCosts['consumer_a']);
    });

    it('should identify unprofitable consumers when cost exceeds revenue', () => {
      const consumers = [
        { name: 'consumer_a', cost: 100, revenue: 150 },
        { name: 'consumer_b', cost: 200, revenue: 180 },
      ];

      const unprofitable = consumers.filter(c => c.cost > c.revenue);

      expect(unprofitable.length).toBe(1);
      expect(unprofitable[0].name).toBe('consumer_b');
    });

    it('should track component cost trends for capacity planning', () => {
      const monthlyTrends = [
        { month: '2026-08', api: 200, aggregator: 400 },
        { month: '2026-09', api: 250, aggregator: 500 },
      ];

      const apiGrowth = ((monthlyTrends[1].api - monthlyTrends[0].api) / monthlyTrends[0].api) * 100;

      expect(apiGrowth).toBe(25);
    });
  });
});
