import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { SlashCommand } from './types';
import { BotContext } from '../botContext';
import { extractAssetFingerprints, isValidPolicyId } from '../utils/regex';
import { buildPolicyEmbed } from '../utils/embedBuilder';

const data = new SlashCommandBuilder()
  .setName('lookup')
  .setDescription('Manually look up a Cardano Policy ID or asset fingerprint')
  .addStringOption((opt) =>
    opt
      .setName('target')
      .setDescription('A Policy ID (56 hex chars) or asset fingerprint (asset1...)')
      .setRequired(true)
  );

async function execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const raw = interaction.options.getString('target', true).trim();
  await interaction.deferReply({ ephemeral: false });

  let policyId: string | null = null;
  if (isValidPolicyId(raw)) {
    policyId = raw.toLowerCase();
  } else {
    const fingerprints = extractAssetFingerprints(raw);
    if (fingerprints.length > 0) {
      const resolved = await ctx.blockfrost.getAssetByFingerprint(fingerprints[0]);
      if (resolved?.policyId) policyId = resolved.policyId.toLowerCase();
    }
  }

  if (!policyId) {
    await interaction.editReply('Could not parse that as a Policy ID or resolve the fingerprint.');
    return;
  }

  const [blockfrostData, dexhunterData] = await Promise.all([
    ctx.blockfrost.getPolicySummary(policyId),
    ctx.dexhunter.getStatsByPolicyId(policyId),
  ]);

  const sampleUnit =
    dexhunterData?.unit ??
    blockfrostData?.sampleAssets.find((a) => !/metadata/i.test(a.displayName))?.unit ??
    blockfrostData?.sampleAssets[0]?.unit ??
    null;
  const assetNameHex =
    sampleUnit && sampleUnit.length > 56 ? sampleUnit.slice(56).toLowerCase() : null;
  const snekData = assetNameHex ? await ctx.snek.getStats(policyId, assetNameHex) : null;

  const { record } = ctx.storage.recordSighting(policyId);

  const embed = buildPolicyEmbed({
    policyId,
    blockfrost: blockfrostData,
    dexhunter: dexhunterData,
    snek: snekData,
    firstSeen: false,
    alertCount: record.alertCount,
    tracked: ctx.storage.isTracked(policyId),
    sourceMessageUrl: null,
    call: ctx.storage.getCall(policyId),
  });

  await interaction.editReply({ embeds: [embed] });
}

const command: SlashCommand = { data, execute };
export default command;
