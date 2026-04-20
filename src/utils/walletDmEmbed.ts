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
  label: string | null;
  direction: 'IN' | 'OUT' | 'SELF';
  lovelaceDelta: bigint;
  assetDeltas: WalletAssetDelta[];
  txHash: string;
  blockTime: number;       // unix seconds
  cardanoscanBase: string; // https://cardanoscan.io or https://preprod.cardanoscan.io
}

export interface GroupedMoveEvent {
  displayAddress: string;
  label: string | null;
  direction: 'IN' | 'OUT' | 'SELF';
  lovelaceDelta: bigint;
  feeLovelace: bigint;          // NEW
  assetDeltas: Array<{ unit: string; quantity: bigint; ticker: string; logoCid: string | null; dhUnit: string | null }>;
  primaryTxHash: string;
  otherTxHashes: string[];     // excludes primary
  blockTime: number;
  cardanoscanBase: string;
  hasScriptOutput: boolean;    // NEW
}

const DIRECTION_LABEL = {
  IN:   '⬅️ IN',
  OUT:  '➡️ OUT',
  SELF: '🔁 SELF',
} as const;

function labelOrShort(label: string | null, displayAddress: string): string {
  return label ?? shortenAddress(displayAddress);
}

function formatSignedAda(lovelace: bigint): string {
  const negative = lovelace < 0n;
  const abs = negative ? -lovelace : lovelace;
  const ada = Number(abs) / 1_000_000;
  const sign = negative ? '−' : lovelace === 0n ? '' : '+';
  return `${sign}${formatAda(ada, 2)} ADA`;
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
  const short = labelOrShort(evt.label, evt.displayAddress);
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

export interface BurstSummaryTx {
  txHash: string;
  blockTime: number;   // unix seconds
}

export function buildBurstSummaryEmbed(
  displayAddress: string,
  label: string | null,
  txs: BurstSummaryTx[],
  cardanoscanBase: string,
): EmbedBuilder {
  const count = txs.length;
  const short = labelOrShort(label, displayAddress);
  const sorted = [...txs].sort((a, b) => b.blockTime - a.blockTime);
  const shown = sorted.slice(0, 10);
  const remaining = sorted.length - shown.length;
  const now = Math.floor(Date.now() / 1000);
  const lines = shown.map((t) => {
    const hashShort = t.txHash.length > 12 ? `${t.txHash.slice(0, 8)}…${t.txHash.slice(-4)}` : t.txHash;
    const ago = Math.max(0, now - t.blockTime);
    const when =
      ago < 60 ? `${ago}s ago` :
      ago < 3600 ? `${Math.round(ago / 60)}m ago` :
      ago < 86400 ? `${Math.round(ago / 3600)}h ago` :
      `${Math.round(ago / 86400)}d ago`;
    return `• [\`${hashShort}\`](${cardanoscanBase}/transaction/${t.txHash}) — ${when}`;
  });
  if (remaining > 0) lines.push(`+${remaining} more`);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💸 ${count} moves — ${short}`)
    .setDescription(lines.join('\n'));
}

/**
 * Builds a Zing-style swap or transfer embed for a merged WalletMoveGroup.
 * - BUY: positive asset delta + negative ADA delta (spent ADA, received assets).
 * - SELL: negative asset delta + positive ADA delta (sold assets, received ADA).
 * - Mixed direction or contract-interaction falls through to Transfer variant.
 */
export function buildGroupedMoveEmbed(evt: GroupedMoveEvent): EmbedBuilder {
  const hasPosAsset = evt.assetDeltas.some((d) => d.quantity > 0n);
  const hasNegAsset = evt.assetDeltas.some((d) => d.quantity < 0n);
  const isBuy  = hasPosAsset && evt.lovelaceDelta < 0n;
  const isSell = hasNegAsset && evt.lovelaceDelta > 0n;
  if (isBuy)  return buildSwapEmbed(evt, 'BUY');
  if (isSell) return buildSwapEmbed(evt, 'SELL');
  return buildTransferEmbed(evt);
}

function spoilerHashes(hashes: string[]): string {
  return `||${hashes.map((h) => truncateMiddle(h, 8, 6)).join(', ')}||`;
}

function formatSignedAdaLine(lovelace: bigint): string {
  const negative = lovelace < 0n;
  const abs = negative ? -lovelace : lovelace;
  const ada = Number(abs) / 1_000_000;
  const sign = lovelace === 0n ? '' : negative ? '−' : '+';
  return `${sign}${formatAda(ada, 2)} ADA`;
}

function formatSignedAdaLineWithFee(lovelace: bigint, feeLovelace: bigint): string {
  const base = formatSignedAdaLine(lovelace);
  if (feeLovelace <= 0n) return base;
  const fee = Number(feeLovelace) / 1_000_000;
  return `${base} (incl. ${formatAda(fee, 2)} fee)`;
}

function buildSwapEmbed(evt: GroupedMoveEvent, kind: 'BUY' | 'SELL'): EmbedBuilder {
  const color = kind === 'BUY' ? 0x2ecc71 : 0xe74c3c;
  const emoji = kind === 'BUY' ? '🟢' : '🔴';
  const kindLabel = kind === 'BUY' ? 'Buy' : 'Sell';
  const title = `${emoji} ${kindLabel} — ${labelOrShort(evt.label, evt.displayAddress)}`;

  // Signed asset lines (top 3 by |quantity|)
  const sortedAssets = [...evt.assetDeltas].sort((a, b) => {
    const aa = a.quantity < 0n ? -a.quantity : a.quantity;
    const bb = b.quantity < 0n ? -b.quantity : b.quantity;
    return aa > bb ? -1 : aa < bb ? 1 : 0;
  });
  const shownAssets = sortedAssets.slice(0, 3);
  const more = sortedAssets.length - shownAssets.length;
  const assetLines = shownAssets.map((d) => {
    const neg = d.quantity < 0n;
    const abs = neg ? -d.quantity : d.quantity;
    const sign = neg ? '−' : '+';
    return `${sign}${formatNumber(Number(abs), 0)} ${d.ticker}`;
  });
  if (more > 0) assetLines.push(`(+${more} more)`);

  const descLines = [...assetLines, formatSignedAdaLineWithFee(evt.lovelaceDelta, evt.feeLovelace)];

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(descLines.join('\n'));

  const firstLogo = shownAssets.find((d) => d.logoCid)?.logoCid;
  if (firstLogo) embed.setThumbnail(`https://ipfs.io/ipfs/${firstLogo}`);

  const txLinks = [`[Cardanoscan](${evt.cardanoscanBase}/transaction/${evt.primaryTxHash})`];
  const firstDhUnit = shownAssets.find((d) => d.dhUnit)?.dhUnit;
  if (firstDhUnit) {
    const cleanUnit = firstDhUnit.replace('.', '');
    txLinks.push(`[DexHunter](https://app.dexhunter.io/trade/${cleanUnit})`);
  }
  embed.addFields({ name: 'Tx', value: txLinks.join(' · ') });

  if (evt.otherTxHashes.length > 0) {
    embed.addFields({ name: 'Also', value: spoilerHashes(evt.otherTxHashes) });
  }

  if (evt.blockTime > 0) embed.setTimestamp(new Date(evt.blockTime * 1000));
  return embed;
}

function buildTransferEmbed(evt: GroupedMoveEvent): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💸 Wallet moved — ${labelOrShort(evt.label, evt.displayAddress)}`)
    .addFields(
      { name: 'Direction', value: DIRECTION_LABEL[evt.direction], inline: true },
      { name: 'Net ADA',   value: formatSignedAdaLineWithFee(evt.lovelaceDelta, evt.feeLovelace), inline: true },
    );

  if (evt.assetDeltas.length > 0) {
    const sorted = [...evt.assetDeltas].sort((a, b) => {
      const aa = a.quantity < 0n ? -a.quantity : a.quantity;
      const bb = b.quantity < 0n ? -b.quantity : b.quantity;
      return aa > bb ? -1 : aa < bb ? 1 : 0;
    });
    const shown = sorted.slice(0, 3);
    const more = sorted.length - shown.length;
    const lines = shown.map((d) => {
      const neg = d.quantity < 0n;
      const abs = neg ? -d.quantity : d.quantity;
      const sign = neg ? '−' : '+';
      return `${sign}${formatNumber(Number(abs), 0)} ${d.ticker}`;
    });
    if (more > 0) lines.push(`(+${more} more)`);
    embed.addFields({ name: 'Assets', value: lines.join('\n') });
  }

  if (evt.hasScriptOutput) {
    embed.addFields({
      name: 'Note',
      value: '⚠ Output to a contract — may be a swap request; settlement will arrive as a separate alert.',
    });
  }

  embed.addFields({
    name: 'Tx',
    value: `[Cardanoscan](${evt.cardanoscanBase}/transaction/${evt.primaryTxHash})`,
  });
  if (evt.otherTxHashes.length > 0) {
    embed.addFields({ name: 'Also', value: spoilerHashes(evt.otherTxHashes) });
  }
  if (evt.blockTime > 0) embed.setTimestamp(new Date(evt.blockTime * 1000));
  return embed;
}
