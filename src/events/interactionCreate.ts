import {
  ButtonInteraction,
  Client,
  Events,
  Interaction,
  MessageFlags,
} from 'discord.js';
import { BotContext } from '../botContext';
import { logger } from '../utils/logger';
import { COPY_PREFIX, REFRESH_PREFIX, buildAlertComponents } from '../utils/components';
import { isValidPolicyId } from '../utils/regex';

export function registerInteractionCreate(client: Client, ctx: BotContext): void {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
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
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction, ctx);
    }
  });
}

async function handleButton(interaction: ButtonInteraction, ctx: BotContext): Promise<void> {
  const { customId } = interaction;

  if (customId.startsWith(COPY_PREFIX)) {
    const policyId = customId.slice(COPY_PREFIX.length);
    if (!isValidPolicyId(policyId)) {
      await interaction.reply({ content: 'Invalid policy id on this button.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: `\`\`\`\n${policyId}\n\`\`\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (customId.startsWith(REFRESH_PREFIX)) {
    const policyId = customId.slice(REFRESH_PREFIX.length);
    if (!isValidPolicyId(policyId)) {
      await interaction.reply({ content: 'Invalid policy id on this button.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    try {
      const embed = await ctx.alerts.buildRefreshedEmbed(policyId);
      if (!embed) {
        await interaction.followUp({ content: 'Could not refresh that alert.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.editReply({
        embeds: [embed],
        components: [buildAlertComponents(policyId)],
      });
    } catch (err) {
      logger.error(`Refresh failed for ${policyId}`, err);
      await interaction
        .followUp({ content: 'Refresh failed — check the bot logs.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
}
