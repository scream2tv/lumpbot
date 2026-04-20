import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function parseChannelList(raw: string): string[] {
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export interface LumpBotConfig {
  discord: {
    token: string;
    clientId: string;
    guildId: string;
    alertChannelId: string;
    monitoredChannelIds: string[];
    alphaRoleId: string;
  };
  blockfrost: {
    apiKey: string;
    network: 'mainnet' | 'preprod' | 'preview';
  };
  dexhunter: {
    apiKey: string;
    partnerId: string;
    baseUrl: string;
  };
  koios: {
    baseUrl: string;
    apiKey: string;
  };
  snek: {
    baseUrl: string;
  };
  storage: {
    databasePath: string;
  };
  integrations: {
    externalWebhookUrl: string;
  };
  logging: {
    level: LogLevel;
  };
  walletWatchChannelId: string;
  verifiedWalletRoleId: string;
  walletPollIntervalMs: number;
}

export function loadConfig(): LumpBotConfig {
  const network = optional('BLOCKFROST_NETWORK', 'mainnet') as LumpBotConfig['blockfrost']['network'];
  const databasePath = path.resolve(optional('DATABASE_PATH', './data/lumpbot.sqlite'));
  const logLevel = (optional('LOG_LEVEL', 'info') as LogLevel) || 'info';

  return {
    discord: {
      token: required('DISCORD_TOKEN'),
      clientId: required('CLIENT_ID'),
      guildId: required('GUILD_ID'),
      alertChannelId: required('ALERT_CHANNEL_ID'),
      monitoredChannelIds: parseChannelList(optional('MONITORED_CHANNEL_IDS')),
      alphaRoleId: optional('ALPHA_ROLE_ID'),
    },
    blockfrost: {
      apiKey: required('BLOCKFROST_API_KEY'),
      network,
    },
    dexhunter: {
      apiKey: optional('DEXHUNTER_API_KEY'),
      partnerId: optional('DEXHUNTER_PARTNER_ID'),
      baseUrl: optional('DEXHUNTER_BASE_URL', 'https://api-us.dexhunterv3.app'),
    },
    koios: {
      baseUrl: optional('KOIOS_BASE_URL', 'https://api.koios.rest/api/v1'),
      apiKey: optional('KOIOS_API_KEY'),
    },
    snek: {
      baseUrl: optional('SNEK_BASE_URL', 'https://analytics.snek.fun'),
    },
    storage: {
      databasePath,
    },
    integrations: {
      externalWebhookUrl: optional('EXTERNAL_WEBHOOK_URL'),
    },
    logging: {
      level: logLevel,
    },
    walletWatchChannelId: required('WALLET_WATCH_CHANNEL_ID'),
    verifiedWalletRoleId: required('VERIFIED_WALLET_ROLE_ID'),
    walletPollIntervalMs: Math.max(30000, Number(optional('WALLET_POLL_INTERVAL_MS', '60000')) || 60000),
  };
}
