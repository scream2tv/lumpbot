import { Client, Events } from 'discord.js';
import { BotContext } from '../botContext';
import { logger } from '../utils/logger';

export function registerInteractionCreate(client: Client, ctx: BotContext): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = ctx.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, ctx);
    } catch (err) {
      logger.error(`Command ${interaction.commandName} failed`, err);
      const payload = {
        content: 'Something went wrong running that command. Check the bot logs.',
        ephemeral: true,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => undefined);
      } else {
        await interaction.reply(payload).catch(() => undefined);
      }
    }
  });
}
