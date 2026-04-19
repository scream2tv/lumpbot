import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { SlashCommand } from './types';
import { BotContext } from '../botContext';
import { isValidPolicyId } from '../utils/regex';
import { truncateMiddle } from '../utils/formatters';

const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Manage tracked Cardano Policy IDs for Lump Bot alerts')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Track a Policy ID for enhanced alerts')
      .addStringOption((opt) =>
        opt.setName('policy_id').setDescription('The 56-char Cardano Policy ID').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('label').setDescription('Optional friendly name for this policy').setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Stop tracking a Policy ID')
      .addStringOption((opt) =>
        opt.setName('policy_id').setDescription('The Policy ID to remove').setRequired(true)
      )
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List all tracked Policy IDs'));

async function execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const sub = interaction.options.getSubcommand(true);

  if (sub === 'add') {
    const policyIdRaw = interaction.options.getString('policy_id', true);
    const label = interaction.options.getString('label', false);
    const policyId = policyIdRaw.trim().toLowerCase();

    if (!isValidPolicyId(policyId)) {
      await interaction.reply({ content: 'That does not look like a valid Policy ID (expected 56 hex chars).', ephemeral: true });
      return;
    }

    const record = ctx.storage.addTrackedPolicy(policyId, interaction.user.id, label ?? null);
    const embed = new EmbedBuilder()
      .setTitle('Policy ID tracked')
      .setColor(0x2ecc71)
      .addFields(
        { name: 'Policy ID', value: `\`${policyId}\`` },
        { name: 'Label', value: record.label ?? '—', inline: true },
        { name: 'Added by', value: `<@${record.addedBy}>`, inline: true }
      )
      .setFooter({ text: 'Lump Bot • Cardano Intelligence' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'remove') {
    const policyId = interaction.options.getString('policy_id', true).trim().toLowerCase();
    if (!isValidPolicyId(policyId)) {
      await interaction.reply({ content: 'Invalid Policy ID.', ephemeral: true });
      return;
    }
    const removed = ctx.storage.removeTrackedPolicy(policyId);
    await interaction.reply({
      content: removed ? `Removed \`${policyId}\` from tracking.` : `\`${policyId}\` was not being tracked.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'list') {
    const tracked = ctx.storage.listTrackedPolicies();
    if (tracked.length === 0) {
      await interaction.reply({ content: 'No policies are currently tracked.', ephemeral: true });
      return;
    }

    const lines = tracked.map((t) => {
      const label = t.label ? ` — **${t.label}**` : '';
      return `• \`${truncateMiddle(t.policyId, 12, 8)}\`${label} (added <@${t.addedBy}>)`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Tracked Policy IDs (${tracked.length})`)
      .setColor(0xff7f50)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: 'Lump Bot • Cardano Intelligence' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
}

const command: SlashCommand = { data, execute };
export default command;
