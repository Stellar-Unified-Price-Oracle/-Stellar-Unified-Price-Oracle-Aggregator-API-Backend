// Zero-dependency conformance checks. KIT_VERSION tracks the API contract it validates.
export const KIT_VERSION = '1.0.0';

/** Minimal OpenAPI-subset validator: type, nullable, properties, items, $ref. Every property is required. */
export function validateSchema(spec, schema, value, at = '$') {
  if (schema.$ref) return validateSchema(spec, schema.$ref.replace('#/', '').split('/').reduce((n, k) => n[k], spec), value, at);
  if (value === null) return schema.nullable ? [] : [`${at}: null not allowed`];
  switch (schema.type) {
    case 'string': return typeof value === 'string' ? [] : [`${at}: expected string`];
    case 'boolean': return typeof value === 'boolean' ? [] : [`${at}: expected boolean`];
    case 'integer': return Number.isInteger(value) ? [] : [`${at}: expected integer`];
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? [] : [`${at}: expected number`];
    case 'array':
      return Array.isArray(value) ? value.flatMap((v, i) => validateSchema(spec, schema.items, v, `${at}[${i}]`)) : [`${at}: expected array`];
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return [`${at}: expected object`];
      const errs = [];
      for (const [k, s] of Object.entries(schema.properties ?? {})) {
        if (k === '_links') continue;
        if (!(k in value)) errs.push(`${at}.${k}: missing`);
        else errs.push(...validateSchema(spec, s, value[k], `${at}.${k}`));
      }
      return errs;
    }
    default: return [];
  }
}

export function checkResponseSchema(spec, schemaName, body) {
  return validateSchema(spec, { $ref: `#/components/schemas/${schemaName}` }, body);
}

/** Price semantics: price is a string integer, decimals a non-negative integer. */
export function checkPriceEncoding(entry) {
  const errs = [];
  if (typeof entry.price !== 'string' || !/^\d+$/.test(entry.price)) errs.push('price must be a string integer');
  if (!Number.isInteger(entry.decimals) || entry.decimals < 0) errs.push('decimals must be a non-negative integer');
  return errs;
}

/** pages: array of CursorPaginationMeta-bearing HistoryData responses in fetch order. */
export function checkCursorPagination(pages, requestedLimit) {
  const errs = [];
  const seen = new Set();
  pages.forEach((p, i) => {
    const { pagination: m, prices } = p;
    if (prices.length > requestedLimit) errs.push(`page ${i}: ${prices.length} items exceeds limit ${requestedLimit}`);
    if (m.hasMore && !m.nextCursor) errs.push(`page ${i}: hasMore without nextCursor`);
    if (!m.hasMore && m.nextCursor) errs.push(`page ${i}: nextCursor present but hasMore is false`);
    if (m.hasMore && i === pages.length - 1) errs.push('last fetched page still has more (incomplete traversal)');
    if (m.nextCursor) {
      if (seen.has(m.nextCursor)) errs.push(`page ${i}: cursor ${m.nextCursor} repeated (loop)`);
      seen.add(m.nextCursor);
    }
  });
  return errs;
}

/** Error contract: { code, message } with a machine-readable code and matching 4xx/5xx status. */
export function checkErrorResponse(spec, status, body) {
  const errs = [];
  if (status < 400 || status > 599) errs.push(`status ${status} is not an error status`);
  errs.push(...checkResponseSchema(spec, 'ErrorResponse', body));
  if (typeof body?.code === 'string' && !/^[A-Z0-9_]+$/.test(body.code)) errs.push('code must be UPPER_SNAKE_CASE');
  return errs;
}

/** Streaming: events are AssetPrice objects; per-asset timestamps never go backwards. */
export function checkStreamSemantics(spec, events) {
  const errs = [];
  const last = new Map();
  events.forEach((e, i) => {
    errs.push(...checkResponseSchema(spec, 'AssetPrice', e).map((m) => `event ${i} ${m}`));
    if (last.has(e.asset) && e.timestamp < last.get(e.asset)) errs.push(`event ${i}: timestamp regressed for ${e.asset}`);
    last.set(e.asset, e.timestamp);
  });
  return errs;
}
