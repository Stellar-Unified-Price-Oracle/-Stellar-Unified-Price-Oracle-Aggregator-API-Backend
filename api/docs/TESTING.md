# End-to-End Testing Framework

The API uses **testcontainers** to spin up isolated PostgreSQL and Redis instances for each test run, enabling truly isolated end-to-end testing without external dependencies.

## Quick Start

### Run All Tests

```bash
npm test
```

### Run E2E Tests Only

```bash
npm run test:e2e
```

### Watch Mode

```bash
npm run test:watch
```

## Architecture

### Test Containers

- **PostgreSQL**: Each test suite gets a fresh PostgreSQL container
- **Redis**: Optional Redis container for caching tests (not currently used)
- **Isolation**: Containers are started before tests and cleaned up after

### Database Setup

1. Container starts with a clean database
2. Migrations are automatically applied
3. Tests run against the isolated schema
4. Container is destroyed after tests complete

## Writing Tests

### Basic Test Structure

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupE2E, teardownE2E } from './setup';
import { queryDatabase } from '../../src/services/database';

describe('Feature X', () => {
  beforeAll(async () => {
    await setupE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  });

  it('should do something', async () => {
    const result = await queryDatabase('SELECT * FROM assets');
    expect(result.rowCount).toBe(0);
  });
});
```

### Database Testing

```typescript
it('should insert and retrieve data', async () => {
  // Insert
  const result = await queryDatabase(
    'INSERT INTO assets (code, name, decimals) VALUES ($1, $2, $3) RETURNING *',
    ['XLM', 'Stellar Lumens', 7]
  );

  expect(result.rowCount).toBe(1);
  expect(result.rows[0]).toMatchObject({
    code: 'XLM',
    name: 'Stellar Lumens',
  });
});
```

### API Testing

```typescript
import request from 'supertest';

it('should return prices', async () => {
  const response = await request(app)
    .get('/api/v1/prices')
    .expect(200);

  expect(response.body).toHaveProperty('success', true);
  expect(Array.isArray(response.body.data)).toBe(true);
});
```

## Requirements

- Docker must be running for testcontainers to work
- Tests require `test` environment with proper timeouts

## Configuration

### Timeouts

Tests have a 30-second timeout by default (see `vitest.config.ts`):

```typescript
test: {
  testTimeout: 30000,
  hookTimeout: 30000,
}
```

Increase if needed for slow systems:

```typescript
// In your test file
import { test } from 'vitest';

test('slow test', async () => {
  // test code
}, 60000); // 60 second timeout
```

## Test Organization

```
tests/
├── e2e/
│   ├── setup.ts              # Test container setup
│   ├── api.test.ts           # API endpoint tests
│   └── integration.test.ts    # Full feature integration tests
├── setup/
│   └── test-containers.ts    # Testcontainers configuration
└── unit/
    └── services.test.ts      # Unit tests (optional)
```

## Running in CI/CD

The E2E tests work seamlessly in CI/CD pipelines:

```yaml
# GitHub Actions example
- name: Run E2E tests
  run: npm run test:e2e
  env:
    CI: true
```

## Troubleshooting

### Container fails to start

```
Error: Cannot connect to Docker daemon
```

**Solution**: Ensure Docker is running

```bash
docker ps
```

### Tests timeout

```
Error: Test timeout in setupAll hook
```

**Solution**: Increase timeout or check Docker resource limits

### Port already in use

```
Error: Port 5432 already in use
```

**Solution**: Kill existing containers

```bash
docker ps
docker stop <container_id>
```

## Performance

- First test run: ~10-15 seconds (container startup)
- Subsequent tests: ~2-5 seconds (container reuse within same process)
- Full suite: ~30-60 seconds depending on complexity

## Best Practices

1. **Use `setupE2E()` once per test file**
   - Containers are reused across tests in the same file
   - Different files get separate container instances

2. **Clean data between tests**
   - Use database snapshots or truncate tables
   - Avoid test interdependencies

3. **Mock external services**
   - Don't call real APIs in E2E tests
   - Use nock for HTTP mocks

4. **Test the happy path first**
   - Then add error cases
   - Finally edge cases

## References

- [Testcontainers Documentation](https://testcontainers.com/)
- [Vitest Documentation](https://vitest.dev/)
- [PostgreSQL Testing](https://www.postgresql.org/docs/current/regress.html)
