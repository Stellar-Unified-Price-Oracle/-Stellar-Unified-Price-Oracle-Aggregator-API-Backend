import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import AlertManager, { AlertEvent } from '../src/observability/alert-manager';
import { WebSocketServer } from '../src/infrastructure/ws-server';

describe('WebSocket Alert Broadcasting (Issue #228)', () => {
  let wss: WebSocketServer;
  let alertManager: AlertManager;
  const WS_PORT = 9001;

  beforeAll(async () => {
    wss = new WebSocketServer(WS_PORT);
    wss.start();

    alertManager = new AlertManager({
      enableConsoleLog: false,
      enableFileLog: false,
      webhookUrl: undefined,
      slackWebhookUrl: undefined,
      pagerDutyRoutingKey: undefined,
      emailWebhookUrl: undefined,
    });

    await new Promise(resolve => setTimeout(resolve, 500));
  });

  afterAll(() => {
    wss.stop();
  });

  // The aggregator WS guard requires an Origin header by default; the ws
  // client library does not send one unless asked, so provide it explicitly.
  const connect = (): WebSocket =>
    new WebSocket(`ws://localhost:${WS_PORT + 1}`, { origin: 'http://localhost' });

  it('should suppress duplicate alerts within the dedup window', async () => {
    const alert: AlertEvent = {
      timestamp: Math.floor(Date.now() / 1000),
      asset: 'BTC',
      type: 'deviation',
      message: 'Price deviation alert for BTC: 5.25% change',
      previousPrice: '43000.00',
      currentPrice: '45260.00',
      deviationPercent: 5.25,
    };

    const first = await (alertManager as any).emitAlert(alert);
    const second = await (alertManager as any).emitAlert({ ...alert, timestamp: Math.floor(Date.now() / 1000) + 1 });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('should suppress flapping alerts when the same signal re-triggered within the suppression window', async () => {
    const alert: AlertEvent = {
      timestamp: Math.floor(Date.now() / 1000),
      asset: 'ETH',
      type: 'source_down',
      message: 'All sources down for ETH (3 consecutive failures)',
    };

    const first = await (alertManager as any).emitAlert(alert);
    const second = await (alertManager as any).emitAlert({ ...alert, timestamp: Math.floor(Date.now() / 1000) + 2 });
    const third = await (alertManager as any).emitAlert({ ...alert, timestamp: Math.floor(Date.now() / 1000) + 3 });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
  });

  it('should broadcast price deviation alerts to WebSocket clients', async () => {
    return new Promise<void>((done) => {
      const client = connect();
      let alertReceived = false;

      client.on('open', () => {
        const alert: AlertEvent = {
          timestamp: Math.floor(Date.now() / 1000),
          asset: 'BTC',
          type: 'deviation',
          message: 'Price deviation alert for BTC: 5.25% change',
          previousPrice: '43000.00',
          currentPrice: '45260.00',
          deviationPercent: 5.25,
        };

        wss.broadcastAlert(alert);
      });

      client.on('message', (data: string) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'alert' && message.data.asset === 'BTC') {
            alertReceived = true;
            expect(message.data.type).toBe('deviation');
            expect(message.data.asset).toBe('BTC');
            expect(message.data.message).toContain('Price deviation');
            expect(message.timestamp).toBeDefined();
            client.close();
            done();
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      });

      setTimeout(() => {
        if (!alertReceived) {
          client.close();
          done();
        }
      }, 2000);
    });
  });

  it('should broadcast source down alerts', async () => {
    return new Promise<void>((done) => {
      const client = connect();
      let alertReceived = false;

      client.on('open', () => {
        const alert: AlertEvent = {
          timestamp: Math.floor(Date.now() / 1000),
          asset: 'ETH',
          type: 'source_down',
          message: 'All sources down for ETH (3 consecutive failures)',
        };

        wss.broadcastAlert(alert);
      });

      client.on('message', (data: string) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'alert' && message.data.asset === 'ETH') {
            alertReceived = true;
            expect(message.data.type).toBe('source_down');
            expect(message.data.asset).toBe('ETH');
            client.close();
            done();
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      });

      setTimeout(() => {
        if (!alertReceived) {
          client.close();
          done();
        }
      }, 2000);
    });
  });

  it('should broadcast stale data alerts', async () => {
    return new Promise<void>((done) => {
      const client = connect();
      let alertReceived = false;

      client.on('open', () => {
        const alert: AlertEvent = {
          timestamp: Math.floor(Date.now() / 1000),
          asset: 'XLM',
          type: 'stale',
          message: 'Price data stale for XLM: 180s old (threshold: 120s)',
        };

        wss.broadcastAlert(alert);
      });

      client.on('message', (data: string) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'alert' && message.data.asset === 'XLM') {
            alertReceived = true;
            expect(message.data.type).toBe('stale');
            expect(message.data.asset).toBe('XLM');
            client.close();
            done();
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      });

      setTimeout(() => {
        if (!alertReceived) {
          client.close();
          done();
        }
      }, 2000);
    });
  });

  it('should broadcast alerts to multiple connected clients', async () => {
    return new Promise<void>((done) => {
      const client1 = connect();
      const client2 = connect();
      let client1Received = false;
      let client2Received = false;

      const checkDone = () => {
        if (client1Received && client2Received) {
          client1.close();
          client2.close();
          done();
        }
      };

      client1.on('open', () => {
        client2.on('open', () => {
          const alert: AlertEvent = {
            timestamp: Math.floor(Date.now() / 1000),
            asset: 'BTC',
            type: 'deviation',
            message: 'Price deviation alert for BTC',
            deviationPercent: 3.5,
          };

          wss.broadcastAlert(alert);
        });
      });

      client1.on('message', (data: string) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'alert') {
            client1Received = true;
            checkDone();
          }
        } catch (err) {
          // Ignore
        }
      });

      client2.on('message', (data: string) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'alert') {
            client2Received = true;
            checkDone();
          }
        } catch (err) {
          // Ignore
        }
      });

      setTimeout(() => {
        client1.close();
        client2.close();
        done();
      }, 3000);
    });
  });

  it('should include alert metadata in broadcasts', async () => {
    return new Promise<void>((done) => {
      const client = connect();

      client.on('open', () => {
        const alert: AlertEvent = {
          timestamp: 1640000000,
          asset: 'USDC',
          type: 'deviation',
          message: 'Test deviation',
          previousPrice: '1.00',
          currentPrice: '1.05',
          deviationPercent: 5.0,
          affectedSources: ['Chainlink', 'Redstone'],
        };

        wss.broadcastAlert(alert);
      });

      client.on('message', (data: string) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'alert') {
            expect(message.data.asset).toBe('USDC');
            expect(message.data.type).toBe('deviation');
            expect(message.data.previousPrice).toBe('1.00');
            expect(message.data.currentPrice).toBe('1.05');
            expect(message.data.deviationPercent).toBe(5.0);
            expect(message.data.affectedSources).toEqual(['Chainlink', 'Redstone']);
            expect(message.timestamp).toBeDefined();
            client.close();
            done();
          }
        } catch (err) {
          // Ignore
        }
      });

      setTimeout(() => {
        client.close();
        done();
      }, 2000);
    });
  });
});
