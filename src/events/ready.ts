import { Client, Events } from 'discord.js';
import { BotContext } from '../botContext';
import { logger } from '../utils/logger';

export function registerReady(client: Client, _ctx: BotContext): void {
  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Lump Bot is online as ${readyClient.user.tag}`);
    readyClient.user.setPresence({
      status: 'online',
      activities: [{ name: 'Cardano Policy IDs', type: 3 }],
    });
  });
}
