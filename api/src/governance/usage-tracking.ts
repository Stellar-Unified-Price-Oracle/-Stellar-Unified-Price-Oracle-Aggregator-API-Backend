import { Request, Response, NextFunction } from 'express';

import { usageAnalytics } from '../services/usage-analytics';

interface UsageRecord {
  endpoint: string;
  method: string;
  apiKeyPrefix: string;
  asset?: string;
  status: number;
  timestamp: number;
}

// Local audit/usage log for report generation.
const usageAuditLog: UsageRecord[] = [];

export function usageTrackingMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const apiKeyPrefix = req.apiKey ? req.apiKey.substring(0, 8) : 'anonymous';
    const asset =
      (req.params && (req.params.asset as string | undefined)) ||
      (typeof req.query.asset === 'string' ? req.query.asset : undefined);

    const record: UsageRecord = {
      endpoint: req.route ? req.baseUrl + req.route.path : req.path,
      method: req.method,
      apiKeyPrefix,
      asset: asset ? asset.toUpperCase() : undefined,
      status: res.statusCode,
      timestamp: Date.now(),
    };
    usageAnalytics.record(record);
    usageAuditLog.push(record);
  });
  next();
}

// ============================================================================
// Compliance Regulatory Reporting Automation
// ============================================================================
// Define required recurring reports.
type Schedule = 'daily' | 'weekly' | 'monthly';

interface Report {
  title: string;
  generatedAt: Date;
  data: unknown[];
}

interface RecurringReport {
  name: string;
  schedule: Schedule;
  generate: () => Promise<Report>;
}

const requiredReports: RecurringReport[] = [
  {
    name: 'daily-usage-summary',
    schedule: 'daily',
    generate: async (): Promise<Report> => {
      const start = Date.now() - 24 * 60 * 60 * 1000;
      const records = usageAuditLog.filter(r => r.timestamp >= start);
      return { title: 'Daily Usage Summary', generatedAt: new Date(), data: records };
    },
  },
  {
    name: 'weekly-regulatory-report',
    schedule: 'weekly',
    generate: async (): Promise<Report> => {
      const start = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const records = usageAuditLog.filter(r => r.timestamp >= start);
      return { title: 'Weekly Regulatory Report', generatedAt: new Date(), data: records };
    },
  },
  // Additional reports can be added here as required by applicable regimes.
];

// Determine if a report is due at the given time.
function isDue(report: RecurringReport, now: Date): boolean {
  const startOfDay = now.getHours() === 0 && now.getMinutes() === 0;
  if (report.schedule === 'daily') {
    return startOfDay;
  } else if (report.schedule === 'weekly') {
    return startOfDay && now.getDay() === 1; // Monday
  } else if (report.schedule === 'monthly') {
    return startOfDay && now.getDate() === 1;
  }
  return false;
}

// Placeholder for sending a generated report for compliance review.
async function sendForReview(report: Report): Promise<void> {
  // In a production environment, this would persist the report and notify reviewers.
  console.log(`Compliance report ready for review: ${report.title} (${report.data.length} records)`);
  // TODO: Integrate with email/notification and a workflow system.
}

// Schedule report generation and delivery.
function scheduleReports(): void {
  const checkIntervalMs = 60 * 60 * 1000; // Check every hour.
  setInterval(() => {
    const now = new Date();
    for (const report of requiredReports) {
      if (isDue(report, now)) {
        report.generate()
          .then(reportData => sendForReview(reportData))
          .catch(error => console.error(`Failed to generate report "${report.name}":`, error));
      }
    }
  }, checkIntervalMs);
}

// Start the scheduler once when this module is loaded.
const globalAny = global as any;
if (!globalAny.__usageReportSchedulerStarted) {
  scheduleReports();
  globalAny.__usageReportSchedulerStarted = true;
}