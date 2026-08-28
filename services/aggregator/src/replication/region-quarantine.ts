import { config } from '../infrastructure/config';
import { DriftReport } from './region-price-replicator';

export interface RegionQuarantineStatus {
  region: string;
  quarantined: boolean;
  reason?: string;
}

export class RegionQuarantineManager {
  private status: RegionQuarantineStatus = {
    region: config.region.id,
    quarantined: false,
  };

  evaluate(report: DriftReport): RegionQuarantineStatus {
    if (!config.region.quarantineEnabled) return this.status;

    if (report.maxDriftPercent > config.region.driftAlertPercent) {
      this.status = {
        region: config.region.id,
        quarantined: true,
        reason: `drift ${report.maxDriftPercent.toFixed(4)}% exceeds ${config.region.driftAlertPercent}%`,
      };
      return this.status;
    }

    if (this.status.quarantined && report.maxDriftPercent <= config.region.quarantineRecoverPercent) {
      this.status = {
        region: config.region.id,
        quarantined: false,
      };
    }

    return this.status;
  }

  getStatus(): RegionQuarantineStatus {
    return this.status;
  }
}
