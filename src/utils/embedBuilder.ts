import { EmbedBuilder } from 'discord.js';
import { PolicyAssetSummary } from '../services/koios';
import { DexHunterTokenStats } from '../services/dexhunter';
import { SnekTokenStats } from '../services/snek';
import { PolicyCall } from '../services/storage';
import { formatAda, formatAdaCompact } from './formatters';

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
  const { policyId, blockfrost, dexhunter, snek, sourceMessageUrl, call } = input;

  const ticker = dexhunter?.ticker ?? snek?.ticker ?? null;
  const name =
    dexhunter?.name ??
    blockfrost?.sampleAssets.find((a) => !/metadata/i.test(a.displayName))?.displayName ??
    blockfrost?.sampleAssets[0]?.displayName ??
    snek?.ticker ??
    'Unknown';

  const dexHunterUrl = dexhunter?.unit ? `https://app.dexhunter.io/${dexhunter.unit}` : null;
  const snekUrl = snek?.hasPool ? snek.tokenPageUrl : null;
  const primaryUrl = dexHunterUrl ?? snekUrl;

  const liquidityAda = dexhunter?.liquidityAda ?? snek?.liquidityAda ?? null;
  const volume24hAda = dexhunter?.volume24hAda ?? snek?.volumeAda ?? null;
  const fdvAda = snek?.fdvAda ?? null;

  const description: string[] = [];

  // Heading — neutral, no ALPHA/TRACKED badges.
  const headBits: string[] = ['💊'];
  if (ticker) headBits.push(`**$${ticker}**`);
  if (name && name.toLowerCase() !== ticker?.toLowerCase()) headBits.push(`— ${name}`);
  description.push(headBits.join(' '));
  description.push('');

  // Bonding-curve progress (only when Snek's /curve/progress returned a value).
  if (snek?.curvePercent != null) {
    description.push(`⏳ **${snek.curvePercent.toFixed(1)}%** @ Snek`);
  }

  // FDV is the primary stat, replacing the old spot-price line.
  if (fdvAda != null) {
    description.push(`💎 FDV ${formatAdaCompact(fdvAda)}`);
  } else {
    description.push('💎 FDV _unavailable_');
  }

  // Vol · Age
  const volAge: string[] = [];
  if (volume24hAda != null) volAge.push(`Vol ${formatAdaCompact(volume24hAda)}`);
  const age = ageFromMint(blockfrost?.firstMint?.blockTime ?? null);
  if (age) volAge.push(`Age ${age}`);
  if (volAge.length) description.push(`📊 ${volAge.join(' · ')}`);

  // Liquidity · pairs
  const liqRow: string[] = [];
  if (liquidityAda != null) liqRow.push(`Liq ${formatAdaCompact(liquidityAda)}`);
  if (dexhunter?.pairs?.length) liqRow.push(`${dexhunter.pairs.length} pair${dexhunter.pairs.length > 1 ? 's' : ''}`);
  if (liqRow.length) description.push(`💧 ${liqRow.join(' · ')}`);

  // Top pair
  if (dexhunter?.pairs && dexhunter.pairs.length > 0) {
    const top = dexhunter.pairs[0];
    const liq = top.liquidityAda != null ? ` (${formatAdaCompact(top.liquidityAda)})` : '';
    description.push(`🔄 ${top.dex} · ${top.pair}${liq}`);
  }

  // "Called by" footer — FDV ratio preferred, price ratio as labelled fallback.
  if (call) {
    description.push(buildCallLine(call, {
      nowFdvAda: fdvAda,
      nowPriceAda:
        call.callSource === 'dexhunter'
          ? dexhunter?.priceAda ?? null
          : call.callSource === 'snek'
            ? snek?.priceAda ?? null
            : dexhunter?.priceAda ?? snek?.priceAda ?? null,
    }));
  }

  // Policy ID — tap-to-copy on mobile.
  description.push('');
  description.push(`\`\`\`\n${policyId}\n\`\`\``);

  // Compact link row — only links we're sure will resolve.
  const links: string[] = [];
  if (dexHunterUrl) links.push(`[🛒 DexHunter](${dexHunterUrl})`);
  if (snekUrl) links.push(`[🐍 Snek.fun](${snekUrl})`);
  if (snek?.twitterUrl) links.push(`[𝕏](${snek.twitterUrl})`);
  if (snek?.discordUrl) links.push(`[Discord](${snek.discordUrl})`);
  if (snek?.telegramUrl) links.push(`[TG](${snek.telegramUrl})`);
  if (snek?.websiteUrl) links.push(`[Web](${snek.websiteUrl})`);
  links.push(`[🔍 Cardanoscan](https://cardanoscan.io/tokenPolicy/${policyId})`);
  links.push(`[📊 Cexplorer](https://cexplorer.io/policy/${policyId})`);
  if (blockfrost?.firstMint?.txHash) {
    links.push(`[🧾 Mint](https://cardanoscan.io/transaction/${blockfrost.firstMint.txHash})`);
  }
  if (sourceMessageUrl) links.push(`[💬 Source](${sourceMessageUrl})`);
  description.push(links.join(' · '));

  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setDescription(description.join('\n'))
    .setTimestamp(new Date())
    .setFooter({ text: 'Lump Bot • Cardano Intelligence' });

  embed.setTitle(ticker ? `$${ticker}` : name);
  if (primaryUrl) embed.setURL(primaryUrl);

  return embed;
}

function ageFromMint(mint: Date | string | null): string | null {
  if (!mint) return null;
  const t = mint instanceof Date ? mint.getTime() : new Date(mint).getTime();
  if (!Number.isFinite(t)) return null;
  return compactDuration(Date.now() - t);
}

function compactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 24) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

function buildCallLine(
  call: PolicyCall,
  now: { nowFdvAda: number | null; nowPriceAda: number | null }
): string {
  const bits: string[] = [`🎯 First @ **${escapeMd(call.callerDisplayName)}**`];

  // Prefer FDV — that's what Rick shows and what the user asked for.
  const canFdv = call.callFdvAda != null && call.callFdvAda > 0 && now.nowFdvAda != null;
  if (canFdv) {
    bits.push(`call FDV \`${formatAdaCompact(call.callFdvAda!)}\``);
    bits.push(`now \`${formatAdaCompact(now.nowFdvAda!)}\``);
    bits.push(formatMultiplier(now.nowFdvAda! / call.callFdvAda!));
  } else if (call.callPriceAda != null && call.callPriceAda > 0 && now.nowPriceAda != null) {
    // Last-resort fallback. Labelled so the user knows it isn't FDV-based.
    bits.push(`call px \`${formatAda(call.callPriceAda, 6)}\``);
    bits.push(`now \`${formatAda(now.nowPriceAda, 6)}\``);
    bits.push(`${formatMultiplier(now.nowPriceAda / call.callPriceAda)} _(px)_`);
  } else if (call.callFdvAda != null) {
    bits.push(`call FDV \`${formatAdaCompact(call.callFdvAda)}\``);
  } else if (call.callPriceAda != null) {
    bits.push(`call px \`${formatAda(call.callPriceAda, 6)}\``);
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
