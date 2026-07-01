# Stellar Unified Price Oracle SDKs

The repository now ships OpenAPI-generated SDKs for TypeScript, Python, Rust, and Go. Each SDK is generated from the same API contract in [api/openapi.json](../api/openapi.json), which keeps the clients aligned with the backend.

## Available SDKs

- TypeScript: npm package `@stellar-oracle/client`
- Python: PyPI package `stellar-oracle-client`
- Rust: crates.io package `stellar-oracle-client`
- Go: module `github.com/Stellar-Unified-Price-Oracle/stellaroracleclient`

## Regenerate SDKs

```bash
npm run generate:sdks
```

## TypeScript quick start

```typescript
import { PriceOracleClient } from '@stellar-oracle/client';

const client = new PriceOracleClient({
  apiUrl: 'http://localhost:3000/api/v1',
  wsUrl: 'ws://localhost:3001',
});

const prices = await client.getPrices();
console.log(prices);
```

## Python quick start

```python
from stellar_oracle_client.api_client import ApiClient
from stellar_oracle_client.configuration import Configuration
from stellar_oracle_client.api.prices_api import PricesApi

configuration = Configuration(host="http://localhost:3000")
client = ApiClient(configuration=configuration)
api = PricesApi(client)
prices = api.get_prices()
print(prices)
```

## Rust quick start

```rust
use stellar_oracle_client::apis::prices_api::get_prices;

#[tokio::main]
async fn main() {
    let result = get_prices("http://localhost:3000".to_string(), None).await;
    println!("{:?}", result);
}
```

## Go quick start

```go
package main

import (
  "fmt"
  "github.com/Stellar-Unified-Price-Oracle/stellaroracleclient"
)

func main() {
  cfg := stellaroracleclient.NewConfiguration()
  cfg.Servers[0].URL = "http://localhost:3000"
  client := stellaroracleclient.NewAPIClient(cfg)
  prices, _, err := client.PricesApi.GetPrices(ctx)
  fmt.Println(prices, err)
}
```

## Publishing

Publishing each SDK to its registry is the next operational step after generation:

- npm: `npm publish ./generated/typescript`
- PyPI: `python -m build ./generated/python && twine upload ./generated/python/dist/*`
- crates.io: `cargo publish --manifest-path ./generated/rust/Cargo.toml`
- Go: `cd ./generated/go && go list ./... && go test ./...`

## CI sync

CI runs the repository-wide generated check so SDK drift is detected automatically.

## Installation

```bash
npm install @stellar-oracle/client
```

### Node.js

For Node.js environments, you'll also need the `ws` package:

```bash
npm install ws
```

## Quick Start

```typescript
import { PriceOracleClient } from '@stellar-oracle/client';

const client = new PriceOracleClient({
  apiUrl: 'http://localhost:3000/api/v1',
  wsUrl: 'ws://localhost:3001',
  apiKey: 'sk_xxx', // Your API key
});

// Get all prices
const prices = await client.getPrices();
console.log(prices);

// Get specific asset price
const xlmPrice = await client.getPrice('XLM');
console.log(`XLM: $${xlmPrice.price}`);

// Get price history
const history = await client.getHistory('BTC', {
  limit: 100,
  from: Math.floor(Date.now() / 1000) - 3600, // Last hour
});
console.log(history.data.prices);
```

## API Reference

### Constructor

```typescript
const client = new PriceOracleClient(config?: ClientConfig);
```

**ClientConfig options:**

- `apiUrl` (string): REST API base URL (default: `http://localhost:3000/api/v1`)
- `wsUrl` (string): WebSocket server URL (default: `ws://localhost:3001`)
- `apiKey` (string): Optional API key for authentication
- `timeout` (number): Request timeout in milliseconds (default: `5000`)
- `autoReconnect` (boolean): Auto-reconnect on WebSocket disconnect (default: `true`)
- `maxReconnectAttempts` (number): Maximum reconnection attempts (default: `10`)
- `initialBackoffMs` (number): Initial exponential backoff delay (default: `1000`)
- `maxBackoffMs` (number): Maximum backoff delay (default: `60000`)
- `backoffMultiplier` (number): Backoff multiplier (default: `2`)

### Methods

#### `getPrices(): Promise<PriceData[]>`

Get all current prices from all sources.

```typescript
const prices = await client.getPrices();
// Returns array of PriceData
```

#### `getPrice(asset: string): Promise<PriceData>`

Get the current price for a specific asset.

```typescript
const xlmPrice = await client.getPrice('XLM');
console.log(`XLM: $${xlmPrice.price} (${xlmPrice.sources.length} sources)`);
```

#### `getHistory(asset: string, options?: HistoryOptions): Promise<HistoryResponse>`

Get historical price data for an asset.

```typescript
const history = await client.getHistory('BTC', {
  limit: 50,
  from: Math.floor(Date.now() / 1000) - 86400, // Last 24 hours
});
```

**HistoryOptions:**

- `from` (number): Start timestamp (Unix seconds)
- `to` (number): End timestamp (Unix seconds)
- `limit` (number): Maximum number of entries to return

#### `subscribeToPrices(callback, errorCallback?): Subscription`

Subscribe to all price updates via WebSocket.

```typescript
const subscription = client.subscribeToPrices(
  (prices) => {
    console.log('Price update:', prices);
  },
  (error) => {
    console.error('Subscription error:', error);
  }
);

// Unsubscribe
subscription.unsubscribe();
```

#### `subscribeToAsset(asset: string, callback, errorCallback?): Subscription`

Subscribe to price updates for a specific asset.

```typescript
const subscription = client.subscribeToAsset(
  'XLM',
  (prices) => {
    console.log('XLM price update:', prices[0]);
  },
  (error) => {
    console.error('Subscription error:', error);
  }
);

// Check subscription status
if (subscription.isActive()) {
  console.log('Subscription is active');
}

// Unsubscribe
subscription.unsubscribe();
```

#### `disconnect(): void`

Disconnect WebSocket and cleanup resources.

```typescript
client.disconnect();
```

#### `isConnected(): boolean`

Check if WebSocket is currently connected.

```typescript
if (client.isConnected()) {
  console.log('Connected to oracle');
}
```

## Types

### PriceData

```typescript
interface PriceData {
  asset: string;
  price: string;
  decimals: number;
  sources: string[];
  timestamp: number;
  confidence: number;
  cached?: boolean;
}
```

### HistoryEntry

```typescript
interface HistoryEntry {
  asset: string;
  price: string;
  decimals: number;
  timestamp: number;
  source: string;
}
```

### PriceOracleError

Custom error class thrown by the client.

```typescript
class PriceOracleError extends Error {
  code: string;
  statusCode?: number;
}
```

## Examples

### Browser Usage

```html
<script src="https://cdn.jsdelivr.net/npm/@stellar-oracle/client@1.0.0/dist/index.js"></script>
<script>
  const client = new PriceOracleClient({
    apiUrl: 'https://oracle.stellar.example.com/api/v1',
    wsUrl: 'wss://oracle.stellar.example.com',
    apiKey: 'sk_xxx',
  });

  client.getPrices().then((prices) => {
    console.log('Prices:', prices);
  });

  client.subscribeToPrices((prices) => {
    document.getElementById('prices').innerHTML = prices
      .map((p) => `${p.asset}: $${p.price}`)
      .join('<br>');
  });
</script>
```

### Node.js Usage

```typescript
import { PriceOracleClient } from '@stellar-oracle/client';

async function main() {
  const client = new PriceOracleClient({
    apiUrl: 'http://localhost:3000/api/v1',
    wsUrl: 'ws://localhost:3001',
    apiKey: process.env.ORACLE_API_KEY,
  });

  try {
    // Fetch current prices
    const prices = await client.getPrices();
    console.log('Current prices:', prices);

    // Subscribe to real-time updates
    const subscription = client.subscribeToPrices(
      (prices) => {
        console.log('Price update:', prices);
      },
      (error) => {
        console.error('Error:', error);
      }
    );

    // Keep process alive
    process.on('SIGINT', () => {
      subscription.unsubscribe();
      client.disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to fetch prices:', error);
    process.exit(1);
  }
}

main();
```

### React Hook Usage

```typescript
import { useState, useEffect } from 'react';
import { PriceOracleClient, PriceData } from '@stellar-oracle/client';

function usePriceOracle() {
  const [prices, setPrices] = useState<PriceData[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const client = new PriceOracleClient({
      apiKey: process.env.REACT_APP_ORACLE_API_KEY,
    });

    const subscription = client.subscribeToPrices(
      (prices) => {
        setPrices(prices);
      },
      (error) => {
        setError(error);
      }
    );

    return () => {
      subscription.unsubscribe();
      client.disconnect();
    };
  }, []);

  return { prices, error };
}

function PriceDisplay() {
  const { prices, error } = usePriceOracle();

  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      {prices.map((price) => (
        <div key={price.asset}>
          {price.asset}: ${price.price}
        </div>
      ))}
    </div>
  );
}
```

## Error Handling

```typescript
import { PriceOracleClient, PriceOracleError } from '@stellar-oracle/client';

const client = new PriceOracleClient();

try {
  const price = await client.getPrice('XLM');
} catch (error) {
  if (error instanceof PriceOracleError) {
    console.error(`Error [${error.code}]: ${error.message}`);
    if (error.statusCode === 401) {
      console.error('Invalid API key');
    }
  } else {
    console.error('Unknown error:', error);
  }
}
```

## WebSocket Reconnection

The client automatically handles WebSocket reconnection with exponential backoff:

- Starts with 1 second delay
- Doubles after each attempt
- Maxes out at 60 seconds
- Retries up to 10 times

You can customize these with the `ClientConfig`:

```typescript
const client = new PriceOracleClient({
  autoReconnect: true,
  maxReconnectAttempts: 20,
  initialBackoffMs: 500,
  maxBackoffMs: 30000,
  backoffMultiplier: 1.5,
});
```

## License

Apache-2.0
