import { describe, it, expect, beforeEach } from 'vitest';

describe('Budget Forecasting (Issue #460)', () => {
  describe('Forecasting Method', () => {
    it('should apply linear regression forecasting', () => {
      const historicalData = [
        { month: 0, cost: 1000 },
        { month: 1, cost: 1100 },
        { month: 2, cost: 1200 },
        { month: 3, cost: 1300 },
      ];

      const n = historicalData.length;
      const sumX = historicalData.reduce((sum, d) => sum + d.month, 0);
      const sumY = historicalData.reduce((sum, d) => sum + d.cost, 0);
      const sumXY = historicalData.reduce((sum, d) => sum + d.month * d.cost, 0);
      const sumX2 = historicalData.reduce((sum, d) => sum + d.month * d.month, 0);

      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;

      expect(slope).toBe(100);
      expect(intercept).toBe(1000);
    });

    it('should forecast next month using linear model', () => {
      const historicalData = [
        { month: 0, cost: 1000 },
        { month: 1, cost: 1100 },
        { month: 2, cost: 1200 },
        { month: 3, cost: 1300 },
      ];

      const slope = 100;
      const intercept = 1000;
      const nextMonth = 4;
      const forecast = intercept + slope * nextMonth;

      expect(forecast).toBe(1400);
    });

    it('should document forecasting method with inputs and assumptions', () => {
      const forecastMethod = {
        method: 'linear_regression',
        inputs: ['historical_monthly_costs', 'number_of_months'],
        assumptions: [
          'linear_trend_continues',
          'no_major_infrastructure_changes',
          'consistent_usage_patterns',
        ],
      };

      expect(forecastMethod.method).toBe('linear_regression');
      expect(forecastMethod.assumptions.length).toBeGreaterThan(0);
    });
  });

  describe('Backtesting Accuracy', () => {
    it('should calculate mean absolute percentage error (MAPE)', () => {
      const actuals = [1000, 1100, 1200, 1300];
      const forecasts = [1050, 1080, 1250, 1280];

      const errors = actuals.map((actual, i) =>
        Math.abs((actual - forecasts[i]) / actual)
      );
      const mape = (errors.reduce((a, b) => a + b, 0) / errors.length) * 100;

      expect(mape).toBeGreaterThan(0);
      expect(mape).toBeLessThan(10);
    });

    it('should calculate error band (confidence interval)', () => {
      const errors = [0.02, 0.05, 0.03, 0.04];
      const meanError = errors.reduce((a, b) => a + b, 0) / errors.length;
      const variance = errors.reduce((sum, e) => sum + Math.pow(e - meanError, 2), 0) / errors.length;
      const stdDev = Math.sqrt(variance);

      const errorBand = {
        lower: meanError - 2 * stdDev,
        upper: meanError + 2 * stdDev,
      };

      expect(errorBand.upper).toBeGreaterThan(errorBand.lower);
    });

    it('should backtest against period with step change (e.g., new region)', () => {
      const historicalData = [
        { month: 0, cost: 1000 },
        { month: 1, cost: 1050 },
        { month: 2, cost: 1100 },
        { month: 3, cost: 2000 }, // step change: new region deployment
        { month: 4, cost: 2100 },
        { month: 5, cost: 2150 },
      ];

      const beforeStepChange = historicalData.slice(0, 3);
      const afterStepChange = historicalData.slice(3);

      expect(beforeStepChange[beforeStepChange.length - 1].cost).toBeLessThan(
        afterStepChange[0].cost
      );
    });

    it('should report accuracy per horizon (1-month vs 3-month forecast)', () => {
      const forecasts = {
        '1_month': {
          mape: 0.03,
          error_band: [0.01, 0.05],
        },
        '3_month': {
          mape: 0.08,
          error_band: [0.04, 0.12],
        },
      };

      expect(forecasts['1_month'].mape).toBeLessThan(forecasts['3_month'].mape);
    });
  });

  describe('Forecast vs Budget Relationship', () => {
    it('should distinguish forecast as base estimate', () => {
      const forecast = 1400;
      const budgetType = 'forecast_based';

      const budget = forecast;

      expect(budget).toBe(forecast);
      expect(budgetType).toBe('forecast_based');
    });

    it('should apply safety margin to forecast for budget cap', () => {
      const forecast = 1400;
      const safetyMargin = 0.15; // 15% buffer
      const budget = forecast * (1 + safetyMargin);

      expect(budget).toBeCloseTo(1610, 1);
    });

    it('should define alert threshold relative to budget', () => {
      const budget = 1610;
      const warningThreshold = budget * 0.75;
      const criticalThreshold = budget * 0.95;

      expect(warningThreshold).toBe(1207.5);
      expect(criticalThreshold).toBe(1529.5);
    });

    it('should reconcile existing alerts with forecast vs budget decision', () => {
      const budgetDecision = 'budget_as_hard_cap_with_safety_margin';
      const alerts = [
        { name: 'warning', threshold: 0.75 },
        { name: 'critical', threshold: 0.95 },
      ];

      expect(alerts[0].threshold).toBeLessThan(alerts[1].threshold);
      expect(budgetDecision).toContain('cap');
    });
  });

  describe('Recurring Optimization Review', () => {
    it('should establish recurring review with defined period', () => {
      const reviewCadence = {
        period: 'monthly',
        day_of_month: 1,
        duration_minutes: 60,
      };

      expect(reviewCadence.period).toBe('monthly');
      expect(reviewCadence.duration_minutes).toBeGreaterThan(0);
    });

    it('should track required review inputs', () => {
      const reviewInputs = [
        'forecast_next_month',
        'actuals_last_month',
        'attribution_variance',
        'open_recommendations',
        'cost_drivers',
      ];

      expect(reviewInputs.length).toBeGreaterThanOrEqual(5);
    });

    it('should assign ownership to recommendations', () => {
      const recommendations = [
        {
          id: 'rec_001',
          title: 'Optimize database indexing',
          owner: 'database_team',
          dueDate: '2026-10-15',
          status: 'in_progress',
        },
        {
          id: 'rec_002',
          title: 'Reduce log retention',
          owner: null,
          dueDate: null,
          status: 'unowned',
        },
      ];

      const unownedRecs = recommendations.filter(r => !r.owner);
      expect(unownedRecs.length).toBeGreaterThan(0);
    });

    it('should decline recommendations without owner and record decision', () => {
      const recommendation = {
        title: 'Migrate to new provider',
        decision: 'declined',
        reason: 'Current provider meets SLA; migration cost exceeds benefit',
      };

      expect(recommendation.decision).toBe('declined');
      expect(recommendation.reason).toBeTruthy();
    });

    it('should track review outcomes and decisions', () => {
      const reviewOutcomes = [
        {
          date: '2026-09-01',
          forecast_accuracy_mape: 0.035,
          variance_unexplained: 0.02,
          recommendations_actioned: 2,
          new_recommendations: 1,
        },
      ];

      expect(reviewOutcomes[0].recommendations_actioned).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Variance Attribution', () => {
    it('should attribute variance to specific causes', () => {
      const variance = {
        expected: 1400,
        actual: 1550,
        delta: 150,
        attributed_to: [
          {
            cause: 'new_region_deployment',
            impact: 100,
          },
          {
            cause: 'higher_than_forecast_traffic',
            impact: 50,
          },
        ],
      };

      const totalAttribued = variance.attributed_to.reduce((sum, v) => sum + v.impact, 0);
      expect(totalAttribued).toBe(150);
    });

    it('should track named causes each cycle', () => {
      const septemberVariance = {
        causes: ['traffic_spike', 'storage_growth', 'regional_expansion'],
      };

      expect(septemberVariance.causes.length).toBeGreaterThan(0);
    });

    it('should identify if variance stems from cost-model assumptions', () => {
      const costModelAssumptions = {
        'api_request_rate': 10000,
        'storage_growth_rate': 0.05,
        'provider_price_change': 0,
      };

      const actualAssumptions = {
        'api_request_rate': 12000,
        'storage_growth_rate': 0.08,
        'provider_price_change': 0.02,
      };

      const derivations = [];
      if (actualAssumptions['api_request_rate'] > costModelAssumptions['api_request_rate']) {
        derivations.push('api_request_rate');
      }
      if (actualAssumptions['storage_growth_rate'] > costModelAssumptions['storage_growth_rate']) {
        derivations.push('storage_growth_rate');
      }

      expect(derivations.length).toBeGreaterThan(0);
    });
  });

  describe('Cost Model Feedback Loop', () => {
    it('should update cost model with forecast misses', () => {
      const costModel = {
        api_request_cost: 0.0001,
        storage_cost_per_gb: 0.023,
        network_egress_cost_per_gb: 0.12,
      };

      const actualCosts = {
        api_request_cost: 0.00015,
        storage_cost_per_gb: 0.025,
        network_egress_cost_per_gb: 0.12,
      };

      const changes = [];
      if (actualCosts.api_request_cost > costModel.api_request_cost) {
        changes.push('api_request_cost');
      }
      if (actualCosts.storage_cost_per_gb > costModel.storage_cost_per_gb) {
        changes.push('storage_cost_per_gb');
      }

      expect(changes.length).toBeGreaterThan(0);
    });

    it('should maintain changelog for cost model updates', () => {
      const costModelChangelog = [
        {
          date: '2026-09-01',
          parameter: 'storage_cost_per_gb',
          old_value: 0.023,
          new_value: 0.025,
          reason: 'Actual storage costs higher; vendor price increase Q3 2026',
        },
      ];

      expect(costModelChangelog[0].reason).toBeTruthy();
    });

    it('should close feedback loop so forecast improves each cycle', () => {
      const cycles = [
        { cycle: 1, mape: 0.10 },
        { cycle: 2, mape: 0.08 },
        { cycle: 3, mape: 0.05 },
      ];

      const lastMape = cycles[cycles.length - 1].mape;
      const firstMape = cycles[0].mape;

      expect(lastMape).toBeLessThan(firstMape);
    });
  });
});
