import { EmbedBuilder } from 'discord.js';
import { PolicyAssetSummary } from '../services/blockfrost';
import { DexHunterTokenStats } from '../services/dexhunter';
import { SnekTokenStats } from '../services/snek';
import { PolicyCall } from '../services/storage';
import { formatAda, formatAdaCompact, formatDateIso, formatNumber } from './formatters';

export interface BuildAlertEmbedInput {
  policyId: string;
  blockfrost: PolicyAssetSummary | null;
  dexhunter: DexHunterTokenStats | null;
  snek: SnekTokenStats | null;
  firstSeen: boolean;
  alertCount: number;
  tracked: boolean;
  sourceMessageUrl: string | null;
  call: PolicyCall | null;
}

const PURPLE = 0xa855f7;

export function buildPolicyEmbed(input: BuildAlertEmbedInput): EmbedBuilder {
  const { policyId, blockfrost, dexhunter, snek, firstSeen, alertCount, tracked, sourceMessageUrl, call } = input;

  const ticker = dexhunter?.ticker ?? snek?.ticker ?? null;
  const name =
    dexhunter?.name ??
    blockfrost?.sampleAssets.find((a) => !/metadata/i.test(a.displayName))?.displayName ??
    blockfrost?.sampleAssets[0]?.displayName ??
    snek?.ticker ??
    'Unknown';

  // DexHunter link is only safe when we actually have a unit.
  const dexHunterUrl = dexhunter?.unit ? `https://app.dexhunter.io/${dexhunter.unit}` : null;
  const snekUrl = snek?.hasPool ? snek.tokenPageUrl : null;
  const primaryUrl = dexHunterUrl ?? snekUrl;

  // Current price/vol/liq/mcap — prefer DexHunter, fall back to Snek.
  const priceAda = dexhunter?.priceAda ?? snek?.priceAda ?? null;
  const liquidityAda = dexhunter?.liquidityAda ?? snek?.liquidityAda ?? null;
  const volume24hAda = dexhunter?.volume24hAda ?? snek?.volumeAda ?? null;
  const priceChangePct = dexhunter?.priceChange24hPct ?? null;

  const badge = firstSeen ? '✨ **ALPHA**' : tracked ? '⭐ **TRACKED**' : '💊';
  const titleBits = [badge];
  if (ticker) titleBits.push(`**$${ticker}**`);
  if (name && name.toLowerCase() !== ticker?.toLowerCase()) titleBits.push(`— ${name}`);

  const description: string[] = [titleBits.join(' ')];
  if (firstSeen) description.push('_First time this policy has been detected by Lump Bot._');
  description.push('');

  // Price + 24h change
  if (priceAda != null) {
    const changeStr =
      priceChangePct != null
        ? ` · ${priceChangePct >= 0 ? '🟢 ▲' : '🔴 ▼'} ${Math.abs(priceChangePct).toFixed(2)}% 24h`
        : '';
    description.push(`💰 \`${formatAda(priceAda, 6)}\`${changeStr}`);
  } else {
    description.push('💰 _No market data yet_');
  }

  // Market cap (Snek only, since DexHunter doesn't surface it)
  if (snek?.marketCapAda != null) {
    description.push(`💎 MCap ${formatAdaCompact(snek.marketCapAda)}`);
  }

  // Vol · Liq · pairs
  const volLiq: string[] = [];
  if (volume24hAda != null) volLiq.push(`Vol ${formatAdaCompact(volume24hAda)}`);
  if (liquidityAda != null) volLiq.push(`Liq ${formatAdaCompact(liquidityAda)}`);
  if (dexhunter?.pairs?.length) volLiq.push(`${dexhunter.pairs.length} pair${dexhunter.pairs.length > 1 ? 's' : ''}`);
  if (volLiq.length) description.push(`📊 ${volLiq.join(' · ')}`);

  // Assets + alert count
  if (blockfrost) {
    const parts = [`${formatNumber(blockfrost.totalAssets)} asset${blockfrost.totalAssets === 1 ? '' : 's'}`];
    if (alertCount > 1) parts.push(`${formatNumber(alertCount)} alerts`);
    description.push(`📦 ${parts.join(' · ')}`);
  }

  // First mint
  if (blockfrost?.firstMint?.blockTime) {
    const mintDate = formatDateIso(blockfrost.firstMint.blockTime).split(' ')[0];
    description.push(`📅 Minted ${mintDate}`);
  }

  // Top pair inline (if available)
  if (dexhunter?.pairs && dexhunter.pairs.length > 0) {
    const top = dexhunter.pairs[0];
    const liq = top.liquidityAda != null ? ` (${formatAdaCompact(top.liquidityAda)})` : '';
    description.push(`🔄 ${top.dex} · ${top.pair}${liq}`);
  }

  // Rick-style "called by" footer — use the same price source the call was recorded from.
  if (call) {
    const nowPrice =
      call.callSource === 'dexhunter'
        ? dexhunter?.priceAda ?? null
        : call.callSource === 'snek'
          ? snek?.priceAda ?? null
          : priceAda;
    description.push(buildCallLine(call, nowPrice));
  }

  // Policy ID code block (tap-to-copy on mobile)
  description.push('');
  description.push(`\`\`\`\n${policyId}\n\`\`\``);

  // Links row — only emit links that will actually resolve.
  const links: string[] = [];
  if (dexHunterUrl) links.push(`[🛒 DexHunter](${dexHunterUrl})`);
  if (snekUrl) links.push(`[🐍 Snek.fun](${snekUrl})`);
  links.push(`[🔍 Cardanoscan](https://cardanoscan.io/tokenPolicy/${policyId})`);
  links.push(`[📊 Cexplorer](https://cexplorer.io/policy/${policyId})`);
  if (blockfrost?.firstMint?.txHash) {
    links.push(`[🧾 Mint Tx](https://cardanoscan.io/transaction/${blockfrost.firstMint.txHash})`);
  }
  if (sourceMessageUrl) links.push(`[💬 Source](${sourceMessageUrl})`);
  description.push(links.join(' · '));

  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setDescription(description.join('\n'))
    .setTimestamp(new Date())
    .setFooter({ text: 'Lump Bot • Cardano Intelligence' });

  // Title is clickable only when we have a primary URL to link to.
  embed.setTitle(ticker ? `$${ticker}` : name);
  if (primaryUrl) embed.setURL(primaryUrl);

  return embed;
}

function buildCallLine(call: PolicyCall, currentPriceAda: number | null): string {
  const bits: string[] = [`🎯 First @ **${escapeMd(call.callerDisplayName)}**`];
  if (call.callPriceAda != null) bits.push(`call \`${formatAda(call.callPriceAda, 6)}\``);
  if (currentPriceAda != null && call.callPriceAda == null) {
    bits.push(`now \`${formatAda(currentPriceAda, 6)}\``);
  }
  if (call.callPriceAda != null && currentPriceAda != null) {
    bits.push(`now \`${formatAda(currentPriceAda, 6)}\``);
    const ratio = currentPriceAda / call.callPriceAda;
    bits.push(formatMultiplier(ratio));
  }
  bits.push(timeSince(call.calledAt));
  return bits.join(' · ');
}

function formatMultiplier(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '—';
  if (ratio >= 1) return `**${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(2)}x** 🚀`;
  return `**${ratio.toFixed(2)}x** 📉`;
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function escapeMd(text: string): string {
  return text.replace(/([\\*_~`|>])/g, '\\$1');
}
