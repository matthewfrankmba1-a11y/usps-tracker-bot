import 'dotenv/config';
import path from 'node:path';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const dataDir = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    // Optional: register commands to a single guild for instant availability.
    guildId: process.env.DISCORD_GUILD_ID || '',
  },
  poll: {
    intervalMinutes: int('POLL_INTERVAL_MINUTES', 20),
    // Spread carrier calls out a little so every shipment does not fire at once.
    jitterSeconds: int('POLL_JITTER_SECONDS', 30),
    concurrency: int('POLL_CONCURRENCY', 3),
    // Stop polling (and drop) delivered shipments after this long.
    deliveredRetentionHours: int('DELIVERED_RETENTION_HOURS', 48),
    // Give up on a shipment the carrier has never recognised after this long.
    unknownRetentionHours: int('UNKNOWN_RETENTION_HOURS', 24 * 14),
    maxPerUser: int('MAX_PACKAGES_PER_USER', 25),
  },
  http: {
    timeoutMs: int('HTTP_TIMEOUT_MS', 15_000),
    retries: int('HTTP_RETRIES', 2),
  },
  health: {
    enabled: bool('HEALTH_SERVER', true),
    port: int('PORT', 8080),
  },
  storage: {
    dataDir,
    file: path.join(dataDir, 'tracker.json'),
  },
  carriers: {
    usps: {
      clientId: process.env.USPS_CLIENT_ID || '',
      clientSecret: process.env.USPS_CLIENT_SECRET || '',
      baseUrl: process.env.USPS_BASE_URL || 'https://apis.usps.com',
    },
    ups: {
      clientId: process.env.UPS_CLIENT_ID || '',
      clientSecret: process.env.UPS_CLIENT_SECRET || '',
      baseUrl: process.env.UPS_BASE_URL || 'https://onlinetools.ups.com',
    },
    fedex: {
      clientId: process.env.FEDEX_CLIENT_ID || '',
      clientSecret: process.env.FEDEX_CLIENT_SECRET || '',
      baseUrl: process.env.FEDEX_BASE_URL || 'https://apis.fedex.com',
    },
  },
};

/** Fatal config problems — the bot cannot run at all without these. */
export function assertRuntimeConfig(cfg = config) {
  const problems = [];
  if (!cfg.discord.token) problems.push('DISCORD_TOKEN is required');
  if (!cfg.discord.clientId) problems.push('DISCORD_CLIENT_ID is required');
  if (cfg.poll.intervalMinutes < 1) problems.push('POLL_INTERVAL_MINUTES must be >= 1');
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Carriers with credentials present; the rest are reported as unconfigured. */
export function configuredCarriers(cfg = config) {
  return Object.entries(cfg.carriers)
    .filter(([, c]) => c.clientId && c.clientSecret)
    .map(([name]) => name);
}
