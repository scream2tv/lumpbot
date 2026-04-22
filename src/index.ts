import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config';
import { logger, setLogLevel } from './utils/logger';
import { StorageService } from './services/storage';
import { KupoService } from './services/kupo';
import { OgmiosClient } from './services/ogmios';
import { KoiosService } from './services/koios';
import { DexHunterService } from './services/dexhunter';
import { DexHunterChartService } from './services/dexhunterChart';
import { SnekService } from './services/snek';
import { AlertService } from './services/alertService';
import { WalletStreamService } from './services/walletStreamService';
import { buildCommandCollection } from './commands';
import { registerEvents } from './events';
import { BotContext } from './botContext';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logging.level);
  logger.info('Starting Lump Bot', {
    network: config.cardano.network,
    ogmios: config.cardano.ogmiosWsUrl,
    kupo: config.cardano.kupoUrl,
    monitoredChannels: config.discord.monitoredChannelIds.length || 'all',
    alphaRole: config.discord.alphaRoleId || 'disabled',
  });

  const storage = new StorageService(config.storage.databasePath);
  const kupo = new KupoService(config.cardano);
  const ogmios = new OgmiosClient(config.cardano);
  const koios = new KoiosService(config);
  const dexhunter = new DexHunterService(config);
  const dexhunterChart = new DexHunterChartService(config);
  const snek = new SnekService(config);

  const [ogmiosHealth, kupoHealth] = await Promise.all([ogmios.health(), kupo.health()]);
  if (!ogmiosHealth.ok) {
    throw new Error(`Ogmios health check failed at ${config.cardano.ogmiosHealthUrl}: ${ogmiosHealth.detail}`);
  }
  if (!kupoHealth.ok) {
    throw new Error(`Kupo health check failed at ${config.cardano.kupoUrl}/health: ${kupoHealth.detail}`);
  }
  logger.info('Cardano stack healthy', { ogmios: ogmiosHealth.detail, kupo: kupoHealth.detail });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  const alerts = new AlertService(client, config, storage, koios, dexhunter, snek);

  const walletStream = new WalletStreamService(
    storage,
    kupo,
    ogmios,
    snek,
    dexhunter,
    client,
    config.cardano,
  );

  const ctx: BotContext = {
    config,
    storage,
    kupo,
    ogmios,
    koios,
    dexhunter,
    dexhunterChart,
    snek,
    alerts,
    walletStream,
    commands: buildCommandCollection(),
  };

  registerEvents(client, ctx);

  const cleanupInterval = setInterval(
    () => {
      storage.cleanupExpiredAlerts(24 * 60 * 60 * 1000);
      storage.cleanupWalletRateLimit(60 * 60 * 1000);
    },
    60 * 60 * 1000,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(cleanupInterval);
    walletStream.stop();
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
  await walletStream.start();
}

main().catch((err) => {
  logger.error('Fatal error during startup', err);
  process.exit(1);
});
