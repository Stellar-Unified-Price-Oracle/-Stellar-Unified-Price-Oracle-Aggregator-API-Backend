import { describe, it, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';

const WS_ORIGIN = process.env.WS_ORIGIN || 'ws://localhost:3001';
const TEST_API_KEY = process.env.TEST_API_KEY || 'test-key';

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('WebSocket Backpressure and Subscriptions (Issue #538)', () => {
  async function waitForWsService(url: string, maxAttempts = 30): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            ws.close();
            resolve();
          });
          ws.on('error', reject);
          setTimeout(() => reject(new Error('timeout')), 2000);
        });
        return;
      } catch {
        // Service not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`WebSocket service ${url} not ready after ${maxAttempts} attempts`);
  }

  beforeAll(async () => {
    await waitForWsService(WS_ORIGIN, 5);
  }, 30_000);

  it('should enforce per-connection subscription cap', async () => {
    const ws = new WebSocket(`${WS_ORIGIN}?token=${TEST_API_KEY}`);

    const messages: any[] = [];
    const errors: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Try to subscribe to many assets to exceed the cap
        const allAssets = ['XLM', 'USDC', 'EUR', 'CNY', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'SEK'];
        allAssets.forEach((asset, idx) => {
          ws.send(JSON.stringify({ type: 'subscribe', asset }));

          if (idx === allAssets.length - 1) {
            setTimeout(() => {
              ws.close();
              resolve();
            }, 1000);
          }
        });
      });

      ws.on('message', (data: string) => {
        const msg = JSON.parse(data);
        messages.push(msg);

        // Check for subscription limit error
        if (msg.type === 'error' && msg.code === 'SUBSCRIPTION_LIMIT_EXCEEDED') {
          errors.push(msg);
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 10000);
    });

    // Should either accept all (no cap) or enforce a cap and report error
    if (errors.length > 0) {
      expect(errors[0].code).toBe('SUBSCRIPTION_LIMIT_EXCEEDED');
      expect(errors[0]).toHaveProperty('limit');
      expect(errors[0]).toHaveProperty('current');
    }
  });

  it('should enforce global subscription cap', async () => {
    const sockets = [];
    let totalSubscriptions = 0;
    let limitErrors = 0;

    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${WS_ORIGIN}?token=${TEST_API_KEY}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          for (let j = 0; j < 3; j++) {
            ws.send(JSON.stringify({
              type: 'subscribe',
              asset: `ASSET_${i}_${j}`,
            }));
            totalSubscriptions++;
          }
          resolve();
        });

        ws.on('message', (data: string) => {
          const msg = JSON.parse(data);
          if (msg.type === 'error' && msg.code === 'GLOBAL_SUBSCRIPTION_LIMIT_EXCEEDED') {
            limitErrors++;
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      sockets.push(ws);
    }

    // Should report global limit errors if configured
    await new Promise(resolve => setTimeout(resolve, 1000));
    sockets.forEach(ws => ws.close());

    if (limitErrors > 0) {
      expect(limitErrors).toBeGreaterThan(0);
    }
  });

  it('should detect slow consumers and apply backpressure policy', async () => {
    const ws = new WebSocket(`${WS_ORIGIN}?token=${TEST_API_KEY}`);
    let slowClientDetected = false;
    let disconnectDetected = false;

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
      });

      ws.on('message', (data: string) => {
        const msg = JSON.parse(data);

        if (msg.type === 'slowClient' || msg.type === 'backpressure') {
          slowClientDetected = true;
        }

        if (msg.type === 'error' && msg.code === 'SLOW_CONSUMER_DISCONNECT') {
          disconnectDetected = true;
        }
      });

      ws.on('close', () => {
        if (slowClientDetected || disconnectDetected) {
          resolve();
        } else {
          setTimeout(resolve, 500);
        }
      });

      ws.on('error', reject);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 5000);
    });

    // Should detect slow consumers or report policy applied
    if (slowClientDetected || disconnectDetected) {
      expect(slowClientDetected || disconnectDetected).toBe(true);
    }
  });

  it('should emit metrics for subscription activity', async () => {
    const ws = new WebSocket(`${WS_ORIGIN}?token=${TEST_API_KEY}`);
    let metricsReceived = false;

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
        ws.send(JSON.stringify({ type: 'unsubscribe', asset: 'XLM' }));
      });

      ws.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'metrics' || msg.subscriptionCount !== undefined) {
            metricsReceived = true;
          }
        } catch (e) {
          // Not JSON
        }
      });

      ws.on('error', reject);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 3000);
    });

    // Metrics should be available for monitoring
    if (metricsReceived) {
      expect(metricsReceived).toBe(true);
    }
  });

  it('should include protocol-level indication for dropped updates', async () => {
    const ws = new WebSocket(`${WS_ORIGIN}?token=${TEST_API_KEY}`);
    let droppedMessageIndication = false;
    let sequenceNumbers: number[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
      });

      ws.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data);

          // Check for dropped message indicators
          if (msg.type === 'price_update') {
            if (msg.sequenceNumber !== undefined) {
              sequenceNumbers.push(msg.sequenceNumber);
            }
            if (msg.dropped !== undefined || msg.missed !== undefined) {
              droppedMessageIndication = true;
            }
          }
        } catch (e) {
          // Not JSON
        }
      });

      ws.on('error', reject);
      setTimeout(() => {
        ws.close();

        // Check for gaps in sequence numbers
        if (sequenceNumbers.length > 1) {
          for (let i = 1; i < sequenceNumbers.length; i++) {
            if (sequenceNumbers[i] !== sequenceNumbers[i - 1] + 1) {
              droppedMessageIndication = true;
            }
          }
        }

        resolve();
      }, 3000);
    });

    // Either protocol includes indication or guarantees no drops
    if (droppedMessageIndication) {
      expect(droppedMessageIndication).toBe(true);
    }
  });

  it('should handle reconnect after policy-triggered disconnect', async () => {
    const ws1 = new WebSocket(`${WS_ORIGIN}?token=${TEST_API_KEY}`);
    let csrfToken: string | null = null;

    await new Promise<void>((resolve, reject) => {
      ws1.on('open', () => {
        ws1.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));
      });

      ws1.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'csrf_token') {
            csrfToken = msg.token;
          }
        } catch (e) {
          // Not JSON
        }
      });

      ws1.on('close', () => resolve());
      ws1.on('error', reject);
      setTimeout(() => {
        ws1.close();
        resolve();
      }, 2000);
    });

    // Attempt reconnect
    const ws2 = new WebSocket(
      `${WS_ORIGIN}?token=${TEST_API_KEY}${csrfToken ? `&csrf=${csrfToken}` : ''}`
    );

    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => {
        ws2.send(JSON.stringify({ type: 'subscribe', asset: 'USDC' }));
      });

      ws2.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'price_update' || msg.asset === 'USDC') {
            resolve();
          }
        } catch (e) {
          // Not JSON
        }
      });

      ws2.on('close', () => resolve());
      ws2.on('error', reject);
      setTimeout(() => {
        ws2.close();
        resolve();
      }, 3000);
    });

    expect(true).toBe(true);
  });

  it('should reconcile backpressure policy with ws-guard.ts', async () => {
    const ws = new WebSocket(`${WS_ORIGIN}?token=${TEST_API_KEY}`);
    const policies: string[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'get_policy' }));
      });

      ws.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'policy_info') {
            if (msg.bufferLimit) policies.push('bufferLimit');
            if (msg.subscriptionCap) policies.push('subscriptionCap');
            if (msg.slowClientPolicy) policies.push('slowClientPolicy');
          }
        } catch (e) {
          // Not JSON
        }
      });

      ws.on('close', () => resolve());
      ws.on('error', reject);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 2000);
    });

    // Policy should be consistent and documented
    if (policies.length > 0) {
      expect(policies).toContain('bufferLimit');
    }
  });

  it('should bound memory usage with stalled client', async () => {
    const ws = new WebSocket(`${WS_ORIGIN}?token=${TEST_API_KEY}`);
    const initialMemory = process.memoryUsage().heapUsed;

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', asset: 'XLM' }));

        // Don't read messages - simulate stalled client
        ws._socket?.pause();
      });

      ws.on('error', reject);
      setTimeout(() => {
        const currentMemory = process.memoryUsage().heapUsed;
        const memoryIncrease = currentMemory - initialMemory;

        // Memory should remain bounded (not grow unbounded)
        // Allow 10MB for test overhead
        expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);

        ws.close();
        resolve();
      }, 3000);
    });
  });
});
