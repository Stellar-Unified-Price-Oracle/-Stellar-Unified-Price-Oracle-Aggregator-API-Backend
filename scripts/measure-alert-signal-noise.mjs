import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const alertFile = path.resolve(repoRoot, process.argv[2] || 'data/alerts.jsonl');
const soakDays = Number(process.argv[3] || 14);
const cutoffSeconds = Math.floor(Date.now() / 1000) - soakDays * 24 * 60 * 60;

function alertKey(alert) {
  const asset = String(alert.asset || 'unknown').toUpperCase();
  const type = String(alert.type || 'unknown');
  const source = alert.source || alert.affectedSources?.join(',') || 'global';
  return `${asset}:${type}:${source}`;
}

function summarizeAlertHistory(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      totalRawAlerts: 0,
      uniqueActionableAlerts: 0,
      signalToNoiseRatio: 0,
      notes: 'No alert history file exists yet. Run the aggregator for at least 14 days to measure the signal-to-noise ratio.',
    };
  }

  const rawEvents = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((alert) => Number(alert.timestamp) >= cutoffSeconds);

  const uniqueKeys = new Set(rawEvents.map(alertKey));
  const noise = Math.max(rawEvents.length - uniqueKeys.size, 0);
  const signalToNoiseRatio = uniqueKeys.size === 0 ? 0 : uniqueKeys.size / Math.max(noise, 1);

  return {
    totalRawAlerts: rawEvents.length,
    uniqueActionableAlerts: uniqueKeys.size,
    noiseEvents: noise,
    signalToNoiseRatio,
    soakDays,
    cutoffTimestamp: cutoffSeconds,
  };
}

const summary = summarizeAlertHistory(alertFile);
console.log(JSON.stringify(summary, null, 2));
