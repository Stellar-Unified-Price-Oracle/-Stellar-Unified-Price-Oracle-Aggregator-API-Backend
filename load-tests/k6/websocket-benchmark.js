import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

const messageCount = new Counter('ws_messages_received');
const connectTime = new Trend('ws_connect_time', true);
const errorRate = new Rate('ws_error_rate');

const WS_URL = __ENV.WS_URL || 'ws://localhost:4000';

export const options = {
  scenarios: {
    ws_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 10 },
        { duration: '1m', target: 10 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    ws_connect_time: ['p(95)<500'],
    ws_error_rate: ['rate<0.05'],
    ws_messages_received: ['count>0'],
  },
};

export default function () {
  const start = Date.now();
  const res = ws.connect(WS_URL, {}, function (socket) {
    connectTime.add(Date.now() - start);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', assets: ['XLM', 'BTC', 'ETH'] }));
    });

    socket.on('message', (msg) => {
      messageCount.add(1);
      try {
        const data = JSON.parse(msg);
        check(data, {
          'has type': (d) => typeof d.type === 'string',
        });
      } catch {}
    });

    socket.on('error', () => {
      errorRate.add(1);
    });

    socket.setTimeout(() => {
      socket.close();
    }, 10000);
  });

  check(res, { 'connected': (r) => r && r.status === 101 });
  sleep(1);
}
