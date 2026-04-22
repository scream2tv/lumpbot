import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildMember,
} from 'discord.js';
import { SlashCommand } from './types';
import { BotContext } from '../botContext';
import {
  parseCardanoAddress,
  deriveStakeAddress,
  shortenAddress,
} from '../utils/cardanoAddress';
import { logger } from '../utils/logger';

function normalizeLabel(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > 32) return cleaned.slice(0, 32);
  return cleaned;
}

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
      )
      .addStringOption((o) =>
        o
          .setName('label')
          .setDescription("Friendly name (e.g. 'My main wallet')")
          .setRequired(false)
          .setMaxLength(32),
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
  const label = normalizeLabel(interaction.options.getString('label'));
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

  // Resolve stake key entirely from the bech32 (CIP-19) — no network call.
  let stakeKey: string;
  let isEnterprise = false;
  let enterpriseNote = '';

  if (parsed.kind === 'reward') {
    stakeKey = parsed.raw;
  } else if (parsed.kind === 'base') {
    const derived = deriveStakeAddress(parsed);
    if (!derived) {
      await interaction.editReply("Couldn't derive stake key from that address.");
      return;
    }
    stakeKey = derived;
  } else if (parsed.kind === 'enterprise') {
    stakeKey = parsed.raw;
    isEnterprise = true;
    enterpriseNote =
      "\n⚠️ This is an enterprise address (no stake key). " +
      "I'll watch only this specific address — funds moved to other addresses won't be detected.";
  } else {
    await interaction.editReply("Pointer addresses aren't supported yet.");
    return;
  }

  let added: import('../services/storage').WalletWatch;
  try {
    added = ctx.storage.addWalletWatch({
      userId,
      stakeKey,
      displayAddress: parsed.raw,
      isEnterprise,
      baselineTxHash: null,
      label,
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

  // Bootstrap the wallet's current UTxOs in the streamer (fire-and-forget;
  // worst case we miss the very first tx if it lands before Kupo responds,
  // which is exceedingly rare for a freshly-added wallet).
  ctx.walletStream
    .onWatchAdded(added)
    .catch((err) => logger.warn('walletStream.onWatchAdded failed', { err }));

  await interaction.editReply(
    `✅ Watching ${label ? `**${label}** (${shortenAddress(parsed.raw)})` : shortenAddress(parsed.raw)}. You'll get a DM in this account when it moves.` +
      enterpriseNote,
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

  await interaction.deferReply({ ephemeral: true });

  const raw = interaction.options.getString('address', true).trim().toLowerCase();

  // Look up the DB row first so we can tell the streamer to un-index it.
  const existing = ctx.storage.listWalletWatches(userId).find((w) =>
    w.stakeKey.toLowerCase() === raw || w.displayAddress.toLowerCase() === raw,
  );

  let removed = ctx.storage.removeWalletWatch(userId, raw);
  let removedWatch = existing ?? null;

  if (!removed) {
    const parsed = parseCardanoAddress(raw);
    if (parsed?.kind === 'base') {
      const derived = deriveStakeAddress(parsed);
      if (derived) {
        removedWatch = ctx.storage.listWalletWatches(userId).find((w) => w.stakeKey === derived) ?? null;
        removed = ctx.storage.removeWalletWatch(userId, derived);
      }
    }
  }

  if (removed && removedWatch) ctx.walletStream.onWatchRemoved(removedWatch);
  await interaction.editReply(removed ? '🗑️ Removed.' : "You weren't watching that wallet.");
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
    const name = r.label
      ? `**${r.label}** (${shortenAddress(r.displayAddress)})`
      : shortenAddress(r.displayAddress);
    return `• ${name} — added ${when}`;
  });
  const header = `You're watching ${rows.length}/${cap} wallets.`;
  await interaction.reply({ content: `${header}\n${lines.join('\n')}`, ephemeral: true });
}

const watchCommand: SlashCommand = { data, execute: run };
export default watchCommand;
