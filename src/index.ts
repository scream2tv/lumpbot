import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config';
import { logger, setLogLevel } from './utils/logger';
import { StorageService } from './services/storage';
import { BlockfrostService } from './services/blockfrost';
import { DexHunterService } from './services/dexhunter';
import { DexHunterChartService } from './services/dexhunterChart';
import { SnekService } from './services/snek';
import { AlertService } from './services/alertService';
import { WalletWatchService } from './services/walletWatchService';
import { WalletWatcher } from './services/walletWatcher';
import { buildCommandCollection } from './commands';
import { registerEvents } from './events';
import { BotContext } from './botContext';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logging.level);
  logger.info('Starting Lump Bot', {
    network: config.blockfrost.network,
    monitoredChannels: config.discord.monitoredChannelIds.length || 'all',
    alphaRole: config.discord.alphaRoleId || 'disabled',
  });

  const storage = new StorageService(config.storage.databasePath);
  const blockfrost = new BlockfrostService(config);
  const dexhunter = new DexHunterService(config);
  const dexhunterChart = new DexHunterChartService(config);
  const snek = new SnekService(config);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  const alerts = new AlertService(client, config, storage, blockfrost, dexhunter, snek);

  const cardanoscanBase = config.blockfrost.network === 'mainnet'
    ? 'https://cardanoscan.io'
    : config.blockfrost.network === 'preprod'
      ? 'https://preprod.cardanoscan.io'
      : 'https://preview.cardanoscan.io';

  const walletWatchService = new WalletWatchService(
    storage,
    blockfrost,
    snek,
    dexhunter,
    client,
    cardanoscanBase,
  );
  const walletWatcher = new WalletWatcher(
    storage,
    walletWatchService,
    config.walletPollIntervalMs,
  );

  const ctx: BotContext = {
    config,
    storage,
    blockfrost,
    dexhunter,
    dexhunterChart,
    snek,
    alerts,
    walletWatchService,
    walletWatcher,
    commands: buildCommandCollection(),
  };

  registerEvents(client, ctx);

  const cleanupInterval = setInterval(
    () => {
      storage.cleanupExpiredAlerts(24 * 60 * 60 * 1000);
      storage.cleanupWalletRateLimit(60 * 60 * 1000);
    },
    60 * 60 * 1000
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(cleanupInterval);
    walletWatcher.stop();
    try {
      await client.destroy();
      storage.close();
    } catch (err) {
      logger.error('Error during shutdown', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', err));
  process.on('uncaughtException', (err) => logger.error('Uncaught exception', err));

  await client.login(config.discord.token);
}

main().catch((err) => {
  logger.error('Fatal error during startup', err);
  process.exit(1);
});
