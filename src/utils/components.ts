import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const REFRESH_PREFIX = 'lumpbot:refresh:';
export const COPY_PREFIX = 'lumpbot:copy:';

export function buildAlertComponents(policyId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COPY_PREFIX}${policyId}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📋')
      .setLabel('Copy CA'),
    new ButtonBuilder()
      .setCustomId(`${REFRESH_PREFIX}${policyId}`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔄')
      .setLabel('Refresh')
  );
}
