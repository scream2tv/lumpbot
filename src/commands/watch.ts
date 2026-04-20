import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildMember,
} from 'discord.js';
import { SlashCommand } from './types';
import { BotContext } from '../botContext';
import { parseCardanoAddress, shortenAddress } from '../utils/cardanoAddress';
import { logger } from '../utils/logger';

const data = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Watch a Cardano wallet and get DM alerts when it moves')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a wallet address to your watch list')
      .addStringOption((o) =>
        o.setName('address').setDescription('addr1… or stake1…').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a wallet address from your watch list')
      .addStringOption((o) =>
        o.setName('address').setDescription('addr1… or stake1…').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show your watched wallets'),
  );

async function run(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  if (interaction.channelId !== ctx.config.walletWatchChannelId) {
    await interaction.reply({
      content: `This command only works in <#${ctx.config.walletWatchChannelId}>.`,
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand(true);
  if (sub === 'add') return handleAdd(interaction, ctx);
  if (sub === 'remove') return handleRemove(interaction, ctx);
  if (sub === 'list') return handleList(interaction, ctx);
}

async function handleAdd(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const userId = interaction.user.id;
  if (ctx.storage.countRecentWatchActions(userId, 'add', 60_000) >= 10) {
    await interaction.reply({ content: 'Slow down — try again in a minute.', ephemeral: true });
    return;
  }
  ctx.storage.recordWatchAction(userId, 'add');

  const raw = interaction.options.getString('address', true);
  const parsed = parseCardanoAddress(raw);
  if (!parsed) {
    await interaction.reply({
      content: "That doesn't look like a valid Cardano address.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member as GuildMember | null;
  const hasVerifiedRole =
    member?.roles?.cache?.has(ctx.config.verifiedWalletRoleId) ?? false;
  const limit = hasVerifiedRole ? 20 : 6;
  if (ctx.storage.countWalletWatches(userId) >= limit) {
    await interaction.reply({
      content:
        `You're at the ${limit}-wallet limit ` +
        `(${hasVerifiedRole ? 'verified' : 'unverified'}). Remove one with /watch remove first.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let stakeKey: string;
  let isEnterprise = false;
  let enterpriseNote = '';
  let baselineTxHash: string | null = null;
  let neverActive = false;

  try {
    if (parsed.kind === 'stake') {
      stakeKey = parsed.raw;
    } else {
      const resolved = await ctx.blockfrost.getStakeKeyForAddress(parsed.raw);
      if (resolved) {
        stakeKey = resolved;
      } else {
        stakeKey = parsed.raw;
        isEnterprise = true;
        enterpriseNote =
          "\n⚠️ This is an enterprise address (no stake key). " +
          "I'll watch only this specific address — funds moved to other addresses won't be detected.";
      }
    }

    try {
      baselineTxHash = await ctx.walletWatchService.baselineTxHashFor(stakeKey);
    } catch (err: any) {
      if (err?.status_code === 404) {
        neverActive = true;
      } else {
        throw err;
      }
    }
  } catch (err) {
    logger.warn('/watch add: blockfrost lookup failed', { err, raw });
    await interaction.editReply(
      "Couldn't verify that address right now — try again in a moment.",
    );
    return;
  }

  try {
    ctx.storage.addWalletWatch({
      userId,
      stakeKey,
      displayAddress: parsed.raw,
      isEnterprise,
      baselineTxHash,
    });
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      await interaction.editReply("You're already watching that wallet.");
      return;
    }
    logger.error('/watch add: insert failed', { err });
    await interaction.editReply('Something went wrong saving that. Try again.');
    return;
  }

  const neverActiveNote = neverActive
    ? "\nℹ️ This address has no on-chain activity yet. I'll DM you when it does."
    : '';

  await interaction.editReply(
    `✅ Watching ${shortenAddress(parsed.raw)}. You'll get a DM in this account when it moves.` +
      `${enterpriseNote}${neverActiveNote}`,
  );
}

async function handleRemove(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const userId = interaction.user.id;
  if (ctx.storage.countRecentWatchActions(userId, 'remove', 60_000) >= 10) {
    await interaction.reply({ content: 'Slow down — try again in a minute.', ephemeral: true });
    return;
  }
  ctx.storage.recordWatchAction(userId, 'remove');

  const raw = interaction.options.getString('address', true).trim().toLowerCase();
  let removed = ctx.storage.removeWalletWatch(userId, raw);
  if (!removed) {
    const parsed = parseCardanoAddress(raw);
    if (parsed && parsed.kind === 'payment') {
      try {
        const stakeKey = await ctx.blockfrost.getStakeKeyForAddress(parsed.raw);
        if (stakeKey) removed = ctx.storage.removeWalletWatch(userId, stakeKey);
      } catch {
        // best-effort
      }
    }
  }

  await interaction.reply({
    content: removed ? '🗑️ Removed.' : "You weren't watching that wallet.",
    ephemeral: true,
  });
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const userId = interaction.user.id;
  const member = interaction.member as GuildMember | null;
  const hasVerifiedRole =
    member?.roles?.cache?.has(ctx.config.verifiedWalletRoleId) ?? false;
  const cap = hasVerifiedRole ? 20 : 6;

  const rows = ctx.storage.listWalletWatches(userId);
  if (rows.length === 0) {
    await interaction.reply({
      content: "You're not watching any wallets yet. Use /watch add <address>.",
      ephemeral: true,
    });
    return;
  }

  const lines = rows.map((r) => {
    const ago = Math.max(1, Math.round((Date.now() - r.createdAt) / 60_000));
    const when =
      ago < 60 ? `${ago}m ago` :
      ago < 60 * 24 ? `${Math.round(ago / 60)}h ago` :
      `${Math.round(ago / (60 * 24))}d ago`;
    return `• ${shortenAddress(r.displayAddress)} — added ${when}`;
  });
  const header = `You're watching ${rows.length}/${cap} wallets.`;
  await interaction.reply({ content: `${header}\n${lines.join('\n')}`, ephemeral: true });
}

const watchCommand: SlashCommand = { data, execute: run };
export default watchCommand;
