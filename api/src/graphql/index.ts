import { Router, type Request, type Response } from 'express';
import { graphql } from 'graphql';
import { schema } from './schema';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      endpoint: '/graphql',
      schema: 'Price, Query',
      example: `query { prices(asset: "XLM", limit: 5) { asset price source updatedAt } }`,
    },
  });
});

router.post('/', async (req: Request, res: Response) => {
  const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
  const query = payload.query || '';
  const variables = payload.variables ?? {};
  const operationName = payload.operationName ?? undefined;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_QUERY', message: 'GraphQL query is required.' } });
  }

  if (query.length > 10000) {
    return res.status(413).json({ success: false, error: { code: 'QUERY_TOO_LARGE', message: 'GraphQL query exceeds the size limit.' } });
  }

  const result = await graphql({
    schema,
    source: query,
    variableValues: variables,
    operationName,
  });

  if (result.errors?.length) {
    return res.status(400).json({ success: false, data: result.data ?? null, errors: result.errors.map((error) => ({ message: error.message })) });
  }

  return res.json({ success: true, data: result.data });
});

export default router;
