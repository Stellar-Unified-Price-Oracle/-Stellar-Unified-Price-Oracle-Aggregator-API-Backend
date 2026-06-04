import { z } from 'zod';

export const AssetQuerySchema = z.object({
  asset: z.string().min(1).max(10).optional(),
});

export const HistoryQuerySchema = z.object({
  asset: z.string().min(1).max(10),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100),
});

export const HealthResponseSchema = z.object({
  service: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  uptime: z.number(),
  timestamp: z.number(),
});
