// Deterministic fixtures. Timestamps are fixed so SDK assertions are reproducible.
export const FIXED_TS = '2024-01-01T00:00:00.000Z';

export const prices = {
  'XLM/USD': { asset: 'XLM/USD', price: '0.1200', timestamp: FIXED_TS, sources: 3 },
  'BTC/USD': { asset: 'BTC/USD', price: '42000.0000', timestamp: FIXED_TS, sources: 4 },
};

export const wsTicks = Object.values(prices).map((p) => ({ type: 'price', ...p }));
