import { z, ZodError } from 'zod';

const assetValidator = z.string().min(1).refine(
  (val) => {
    if (/^[A-Z0-9]{1,12}$/.test(val)) return true;
    if (val.startsWith('C') && val.length === 56) return true;
    return false;
  },
  { message: 'Invalid asset: must be a 1-12 character uppercase symbol (e.g. XLM, USDC) or a 56-character Soroban contract ID starting with C' }
);

export const AssetQuerySchema = z.object({
  asset: assetValidator.optional(),
});

export const HistoryQuerySchema = z.object({
  asset: assetValidator,
  from: z.coerce.number().int().positive().optional().describe('Unix timestamp (seconds) for range start'),
  to: z.coerce.number().int().positive().optional().describe('Unix timestamp (seconds) for range end'),
  limit: z.coerce.number().int().min(1, 'limit must be at least 1').max(1000, 'limit cannot exceed 1000').default(100),
});

export const HealthResponseSchema = z.object({
  service: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  uptime: z.number(),
  timestamp: z.number(),
});

export interface ValidationError {
  field: string;
  message: string;
  received?: unknown;
}

export function formatZodErrors(error: ZodError): ValidationError[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : 'body';
    let message = issue.message;

    if (issue.code === 'invalid_type') {
      message = `'${field}' must be ${issue.expected}, received ${issue.received}`;
    } else if (issue.code === 'too_small') {
      const kind = issue.type === 'string' ? 'characters' : '';
      message = `'${field}' is too small: minimum is ${issue.minimum} ${kind}`.trim();
    } else if (issue.code === 'too_big') {
      const kind = issue.type === 'string' ? 'characters' : '';
      message = `'${field}' is too large: maximum is ${issue.maximum} ${kind}`.trim();
    } else if (issue.code === 'invalid_enum_value') {
      message = `'${field}' must be one of: ${issue.options.join(', ')}`;
    } else if (issue.code === 'invalid_string') {
      message = `'${field}' has invalid format: ${issue.message}`;
    }

    return { field, message };
  });
}

export function formatValidationResponse(error: ZodError) {
  const errors = formatZodErrors(error);
  return {
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: `Validation failed: ${errors.map((e) => e.message).join('; ')}`,
      fields: errors,
    },
  };
}
