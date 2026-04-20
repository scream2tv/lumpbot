import { EmbedBuilder } from 'discord.js';
import { formatAda, formatNumber, truncateMiddle, hexToUtf8Safe } from './formatters';
import { shortenAddress, splitCardanoUnit } from './cardanoAddress';

export interface WalletAssetDelta {
  unit: string;
  quantity: bigint;
  label?: string;
}

export interface WalletMoveEvent {
  displayAddress: string;
  direction: 'IN' | 'OUT' | 'SELF';
  lovelaceDelta: bigint;
  assetDeltas: WalletAssetDelta[];
  txHash: string;
  blockTime: number;       // unix seconds
  cardanoscanBase: string; // https://cardanoscan.io or https://preprod.cardanoscan.io
}

export interface GroupedMoveEvent {
  displayAddress: string;
  direction: 'IN' | 'OUT' | 'SELF';
  lovelaceDelta: bigint;
  assetDeltas: Array<{ unit: string; quantity: bigint; ticker: string; logoCid: string | null }>;
  primaryTxHash: string;
  otherTxHashes: string[];     // excludes primary
  blockTime: number;
  cardanoscanBase: string;
}

const DIRECTION_LABEL = {
  IN:   '⬅️ IN',
  OUT:  '➡️ OUT',
  SELF: '🔁 SELF',
} as const;

function formatSignedAda(lovelace: bigint): string {
  const negative = lovelace < 0n;
  const abs = negative ? -lovelace : lovelace;
  const ada = Number(abs) / 1_000_000;
  const sign = negative ? '−' : lovelace === 0n ? '' : '+';
  return `${sign}${formatAda(ada, 2)} ADA`;
}

function absAdaStr(lovelace: bigint): string {
  const abs = lovelace < 0n ? -lovelace : lovelace;
  const ada = Number(abs) / 1_000_000;
  return `${formatAda(ada, 2)} ADA`;
}

function assetLabel(d: WalletAssetDelta): string {
  if (d.label) return d.label;
  const { assetNameHex, policyId } = splitCardanoUnit(d.unit);
  if (!assetNameHex) return `NFT ${truncateMiddle(policyId, 6, 4)}`;
  const decoded = hexToUtf8Safe(assetNameHex);
  if (decoded && /^[\x20-\x7e]+$/.test(decoded)) return decoded;
  return `NFT ${truncateMiddle(policyId, 6, 4)}`;
}

function formatAssetLine(d: WalletAssetDelta): string {
  const neg = d.quantity < 0n;
  const abs = neg ? -d.quantity : d.quantity;
  const sign = neg ? '−' : '+';
  return `${sign} ${formatNumber(Number(abs), 0)} ${assetLabel(d)}`;
}

export function buildWalletMoveEmbed(evt: WalletMoveEvent): EmbedBuilder {
  const short = shortenAddress(evt.displayAddress);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💸 Wallet moved — ${short}`)
    .addFields(
      { name: 'Direction', value: DIRECTION_LABEL[evt.direction], inline: true },
      { name: 'Net ADA',   value: formatSignedAda(evt.lovelaceDelta), inline: true },
    );

  if (evt.assetDeltas.length > 0) {
    const shown = evt.assetDeltas.slice(0, 3).map(formatAssetLine);
    const more = evt.assetDeltas.length - shown.length;
    const value = shown.join('\n') + (more > 0 ? `\n… and ${more} more` : '');
    embed.addFields({ name: 'Assets', value });
  }

  embed.addFields({
    name: 'Tx',
    value: `[cardanoscan](${evt.cardanoscanBase}/transaction/${evt.txHash})`,
  });

  if (evt.blockTime > 0) {
    embed.setTimestamp(new Date(evt.blockTime * 1000));
  }
  return embed;
}

export function buildWalletMovePlaintext(evt: WalletMoveEvent): string {
  const short = shortenAddress(evt.displayAddress);
  return `💸 Wallet ${short} moved: ${evt.cardanoscanBase}/transaction/${evt.txHash}`;
}

export function buildBurstSummaryEmbed(
  displayAddress: string,
  count: number,
  latestTxHash: string,
  cardanoscanBase: string,
): EmbedBuilder {
  const short = shortenAddress(displayAddress);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💸 ${count} moves — ${short}`)
    .setDescription(`Latest: [cardanoscan](${cardanoscanBase}/transaction/${latestTxHash})`);
}

/**
 * Builds a Zing-style swap or transfer embed for a merged WalletMoveGroup.
 * - Swap variant: used when assetDeltas.length > 0 (shows BUY/SELL).
 * - Transfer variant: pure ADA move, keeps existing layout.
 */
export function buildGroupedMoveEmbed(evt: GroupedMoveEvent): EmbedBuilder {
  const short = shortenAddress(evt.displayAddress);
  const hasAssets = evt.assetDeltas.length > 0;

  if (hasAssets) {
    return buildSwapEmbed(evt, short);
  } else {
    return buildTransferEmbed(evt, short);
  }
}

function buildSwapEmbed(evt: GroupedMoveEvent, short: string): EmbedBuilder {
  const isBuy = evt.assetDeltas.some((d) => d.quantity > 0n);
  const color = isBuy ? 0x2ecc71 : 0xe74c3c;
  const title = isBuy ? `🟢 Buy — ${short}` : `🔴 Sell — ${short}`;

  // Build asset lines (top 3 by |quantity|)
  const sorted = [...evt.assetDeltas].sort((a, b) => {
    const aa = a.quantity < 0n ? -a.quantity : a.quantity;
    const bb = b.quantity < 0n ? -b.quantity : b.quantity;
    return aa > bb ? -1 : aa < bb ? 1 : 0;
  });
  const shown = sorted.slice(0, 3);
  const extra = sorted.length - shown.length;
  const assetLines = shown.map((d) => {
    const abs = d.quantity < 0n ? -d.quantity : d.quantity;
    return `${formatNumber(Number(abs), 0)} ${d.ticker}`;
  });
  if (extra > 0) assetLines.push(`+${extra} more`);
  const assetStr = assetLines.join(', ');

  const adaStr = absAdaStr(evt.lovelaceDelta);
  const description = isBuy
    ? `Spent ${adaStr} → Received ${assetStr}`
    : `Sold ${assetStr} → Received ${adaStr}`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description);

  // Thumbnail from logo CID of the first asset with one
  const withLogo = shown.find((d) => d.logoCid);
  if (withLogo?.logoCid) {
    embed.setThumbnail(`https://ipfs.io/ipfs/${withLogo.logoCid}`);
  }

  embed.addFields({
    name: 'Tx',
    value: `[cardanoscan](${evt.cardanoscanBase}/transaction/${evt.primaryTxHash})`,
  });

  if (evt.otherTxHashes.length > 0) {
    const spoilerHashes = evt.otherTxHashes.map((h) => truncateMiddle(h, 8, 6)).join(', ');
    embed.addFields({ name: 'Also', value: `||${spoilerHashes}||` });
  }

  embed.setTimestamp(new Date(evt.blockTime * 1000));
  return embed;
}

function buildTransferEmbed(evt: GroupedMoveEvent, short: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💸 Wallet moved — ${short}`)
    .addFields(
      { name: 'Direction', value: DIRECTION_LABEL[evt.direction], inline: true },
      { name: 'Net ADA',   value: formatSignedAda(evt.lovelaceDelta), inline: true },
    );

  embed.addFields({
    name: 'Tx',
    value: `[cardanoscan](${evt.cardanoscanBase}/transaction/${evt.primaryTxHash})`,
  });

  if (evt.otherTxHashes.length > 0) {
    const spoilerHashes = evt.otherTxHashes.map((h) => truncateMiddle(h, 8, 6)).join(', ');
    embed.addFields({ name: 'Also', value: `||${spoilerHashes}||` });
  }

  if (evt.blockTime > 0) {
    embed.setTimestamp(new Date(evt.blockTime * 1000));
  }
  return embed;
}
