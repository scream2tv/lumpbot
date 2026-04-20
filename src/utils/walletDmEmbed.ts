import { EmbedBuilder } from 'discord.js';

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
  blockTime: number;
  cardanoscanBase: string;
}

export function buildWalletMoveEmbed(evt: WalletMoveEvent): EmbedBuilder {
  return new EmbedBuilder().setTitle(`Wallet moved — ${evt.displayAddress}`);
}

export function buildWalletMovePlaintext(evt: WalletMoveEvent): string {
  return `Wallet ${evt.displayAddress} moved: ${evt.cardanoscanBase}/transaction/${evt.txHash}`;
}

export function buildBurstSummaryEmbed(
  displayAddress: string,
  count: number,
  latestTxHash: string,
  cardanoscanBase: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${count} moves — ${displayAddress}`)
    .setDescription(`Latest: ${cardanoscanBase}/transaction/${latestTxHash}`);
}
