import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '30000', 10),
  stalenessThresholdMs: parseInt(process.env.STALENESS_THRESHOLD_MS || '120000', 10),

  soroban: {
    rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    contractId: process.env.CONTRACT_ID || '',
    networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    adminSecret: process.env.ADMIN_SECRET_KEY || '',
  },

  sources: {
    chainlink: {
      baseUrl: process.env.CHAINLINK_BASE_URL || 'https://min-api.cryptocompare.com/data',
      apiKey: process.env.CHAINLINK_API_KEY || '',
    },
    redstone: {
      baseUrl: process.env.REDSTONE_BASE_URL || 'https://api.redstone.finance',
    },
    band: {
      baseUrl: process.env.BAND_BASE_URL || 'https://laozi1.bandchain.org/api',
    },
    reflector: {
      baseUrl: process.env.REFLECTOR_BASE_URL || 'https://api.reflector.xyz',
    },
  },

  assets: (process.env.WATCHED_ASSETS || 'XLM,USDC,BTC,ETH,USDT').split(','),

  logLevel: process.env.LOG_LEVEL || 'info',

  alerts: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
    webhookRetries: parseInt(process.env.ALERT_WEBHOOK_RETRIES || '3', 10),
    webhookRetryDelayMs: parseInt(process.env.ALERT_WEBHOOK_RETRY_DELAY_MS || '1000', 10),
    enableConsoleLog: process.env.ALERT_CONSOLE_LOG !== 'false',
    enableFileLog: process.env.ALERT_FILE_LOG !== 'false',
    defaultDeviationThresholdPercent: parseFloat(process.env.ALERT_DEVIATION_THRESHOLD || '5'),
    defaultStaleThresholdSeconds: parseInt(process.env.ALERT_STALE_THRESHOLD || '300', 10),
    defaultSourceDownThreshold: parseInt(process.env.ALERT_SOURCE_DOWN_THRESHOLD || '3', 10),
  },
};
