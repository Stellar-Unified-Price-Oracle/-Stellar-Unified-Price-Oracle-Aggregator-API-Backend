import { z } from 'zod';

const assetValidator = z.string().min(1).refine(
  (val) => {
    // Classic Stellar asset: 1-12 uppercase alphanumerics
    if (/^[A-Z0-9]{1,12}$/.test(val)) return true;
    // Soroban contract ID: 56 character string starting with 'C'
    if (val.startsWith('C') && val.length === 56) return true;
    return false;
  },
  { message: 'Invalid asset: must be a classic asset symbol or Soroban contract ID' }
);

export const AssetQuerySchema = z.object({
  asset: assetValidator.optional(),
});

export const HistoryQuerySchema = z.object({
  asset: assetValidator,
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
