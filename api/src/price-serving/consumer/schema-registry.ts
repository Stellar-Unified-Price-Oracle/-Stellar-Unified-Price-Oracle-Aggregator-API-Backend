import { Router } from 'express';

const router = Router();
const registry = {
  registryVersion: '1.0.0',
  compatibility: { policy: 'Additive fields and new enum values are compatible. Existing fields retain meaning and type within a major schema version. Breaking changes require a new major version and a deprecation period of at least 180 days.', deprecationHeaders: ['Deprecation', 'Sunset', 'Link'] },
  schemas: [
    { id: 'rest.price.v1', version: '1.0.0', mediaType: 'application/json', description: 'Version 1 price response returned by GET /api/v1/prices/{asset}', deprecated: true, deprecation: { since: '2026-06-29', sunset: '2027-01-01', successor: 'rest.price.v2', headers: { Deprecation: 'date="Mon, 29 Jun 2026 00:00:00 GMT"', Sunset: 'Fri, 01 Jan 2027 00:00:00 GMT', Link: 'https://docs.stellar-oracle.io/api/migration/v1-to-v2; rel="deprecation"' } }, required: ['asset', 'price', 'timestamp', 'decimals'] },
    { id: 'rest.price.v2', version: '2.0.0', mediaType: 'application/json', description: 'Version 2 price response returned by GET /api/v2/prices/{asset}', deprecated: false, deprecation: null, required: ['asset', 'price', 'timestamp', 'decimals'] },
    { id: 'rest.consumer.quality-report.v1', version: '1.0.0', mediaType: 'application/json', description: 'Consumer selected-feed quality report', deprecated: false, deprecation: null, required: ['reportVersion', 'reportId', 'window', 'feeds', 'coverage', 'quality'] },
    { id: 'stream.connected.v1', version: '1.0.0', mediaType: 'application/json', description: 'API WebSocket connection greeting', deprecated: false, deprecation: null, required: ['type', 'sequenceId', 'sequenceModel', 'replaySupported'] },
    { id: 'stream.error.v1', version: '1.0.0', mediaType: 'application/json', description: 'API WebSocket error', deprecated: false, deprecation: null, required: ['type', 'message'] },
    { id: 'stream.subscribed.v1', version: '1.0.0', mediaType: 'application/json', description: 'API WebSocket subscription acknowledgement', deprecated: false, deprecation: null, required: ['type', 'assets', 'sequenceId'] },
    { id: 'stream.unsubscribed.v1', version: '1.0.0', mediaType: 'application/json', description: 'API WebSocket unsubscription acknowledgement', deprecated: false, deprecation: null, required: ['type', 'assets'] },
    { id: 'stream.price_update.v1', version: '1.0.0', mediaType: 'application/json', description: 'API WebSocket price update', deprecated: false, deprecation: null, required: ['type', 'sequenceId'] },
    { id: 'stream.replay_complete.v1', version: '1.0.0', mediaType: 'application/json', description: 'Bounded replay outcome; gapDetected requires snapshot resynchronization', deprecated: false, deprecation: null, required: ['type', 'sequenceId', 'lastSequenceId', 'truncated', 'remaining', 'gapDetected'] },
    { id: 'stream.pong.v1', version: '1.0.0', mediaType: 'application/json', description: 'API WebSocket ping response', deprecated: false, deprecation: null, required: ['type', 'timestamp', 'sequenceId'] },
  ],
  deprecations: [{ schemaId: 'rest.price.v1', since: '2026-06-29', sunset: '2027-01-01', successor: 'rest.price.v2' }],
};

router.get('/', (_req, res) => res.json(registry));
export default router;
