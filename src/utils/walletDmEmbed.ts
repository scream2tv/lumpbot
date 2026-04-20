import { EmbedBuilder } from 'discord.js';
import { formatAda, formatNumber, truncateMiddle, hexToUtf8Safe } from './formatters';
import { shortenAddress } from './cardanoAddress';

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

function assetLabel(d: WalletAssetDelta): string {
  if (d.label) return d.label;
  const dot = d.unit.indexOf('.');
  if (dot < 0) return d.unit;
  const assetNameHex = d.unit.slice(dot + 1);
  const decoded = hexToUtf8Safe(assetNameHex);
  if (decoded && /^[\x20-\x7e]+$/.test(decoded)) return decoded;
  return `NFT ${truncateMiddle(d.unit.slice(0, dot), 6, 4)}`;
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
