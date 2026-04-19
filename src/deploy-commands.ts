import { REST, Routes } from 'discord.js';
import { loadConfig } from './config';
import { commandList } from './commands';
import { logger, setLogLevel } from './utils/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logging.level);

  const body = commandList.map((cmd) => cmd.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  const scope = process.argv.includes('--global') ? 'global' : 'guild';

  try {
    if (scope === 'global') {
      logger.info(`Registering ${body.length} global commands...`);
      await rest.put(Routes.applicationCommands(config.discord.clientId), { body });
    } else {
      logger.info(`Registering ${body.length} commands for guild ${config.discord.guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
        { body }
      );
    }
    logger.info('Command registration complete.');
  } catch (err) {
    logger.error('Failed to register commands', err);
    process.exit(1);
  }
}

main();
