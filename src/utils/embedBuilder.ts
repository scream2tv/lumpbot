import { EmbedBuilder } from 'discord.js';
import { PolicyAssetSummary } from '../services/blockfrost';
import { DexHunterTokenStats } from '../services/dexhunter';
import { formatAda, formatDateIso, formatNumber, truncateMiddle } from './formatters';

export interface BuildAlertEmbedInput {
  policyId: string;
  blockfrost: PolicyAssetSummary | null;
  dexhunter: DexHunterTokenStats | null;
  firstSeen: boolean;
  alertCount: number;
  tracked: boolean;
  sourceMessageUrl: string | null;
}

const LUMP_COLOR = 0xff7f50;
const ALPHA_COLOR = 0x9b59b6;
const TRACKED_COLOR = 0x2ecc71;

export function buildPolicyEmbed(input: BuildAlertEmbedInput): EmbedBuilder {
  const { policyId, blockfrost, dexhunter, firstSeen, alertCount, tracked, sourceMessageUrl } = input;

  const embed = new EmbedBuilder()
    .setTitle(firstSeen ? 'New Policy ID Detected' : 'Policy ID Detected')
    .setColor(firstSeen ? ALPHA_COLOR : tracked ? TRACKED_COLOR : LUMP_COLOR)
    .setTimestamp(new Date())
    .setFooter({ text: 'Lump Bot • Cardano Intelligence' });

  if (firstSeen) {
    embed.setDescription('**First time this policy has been detected by Lump Bot.**');
  } else if (tracked) {
    embed.setDescription('Tracked policy ID – enhanced alerting active.');
  }

  const ticker = dexhunter?.ticker ?? dexhunter?.name ?? blockfrost?.sampleAssets[0]?.displayName ?? null;
  if (ticker) embed.setAuthor({ name: ticker });

  embed.addFields({
    name: 'Policy ID',
    value: `\`\`\`${policyId}\`\`\``,
    inline: false,
  });

  embed.addFields(
    {
      name: 'Assets Under Policy',
      value: blockfrost ? formatNumber(blockfrost.totalAssets) : 'Unavailable',
      inline: true,
    },
    {
      name: 'First Mint',
      value: blockfrost?.firstMint
        ? `${formatDateIso(blockfrost.firstMint.blockTime)}\n[${truncateMiddle(blockfrost.firstMint.txHash, 8, 6)}](https://cardanoscan.io/transaction/${blockfrost.firstMint.txHash})`
        : 'Unknown',
      inline: true,
    },
    {
      name: 'Alerts (all-time)',
      value: formatNumber(alertCount),
      inline: true,
    }
  );

  embed.addFields(
    {
      name: 'Price (ADA)',
      value: dexhunter?.priceAda != null ? formatAda(dexhunter.priceAda, 6) : 'No market data',
      inline: true,
    },
    {
      name: 'Liquidity',
      value: dexhunter?.liquidityAda != null ? formatAda(dexhunter.liquidityAda, 0) : 'N/A',
      inline: true,
    },
    {
      name: 'Volume 24h',
      value: dexhunter?.volume24hAda != null ? formatAda(dexhunter.volume24hAda, 0) : 'N/A',
      inline: true,
    }
  );

  if (dexhunter?.priceChange24hPct != null) {
    const arrow = dexhunter.priceChange24hPct >= 0 ? '▲' : '▼';
    embed.addFields({
      name: '24h Change',
      value: `${arrow} ${dexhunter.priceChange24hPct.toFixed(2)}%`,
      inline: true,
    });
  }

  if (dexhunter?.pairs && dexhunter.pairs.length > 0) {
    const pairsText = dexhunter.pairs
      .slice(0, 5)
      .map((pair) => {
        const liq = pair.liquidityAda != null ? formatAda(pair.liquidityAda, 0) : 'N/A';
        return `• **${pair.dex}** — ${pair.pair} (${liq})`;
      })
      .join('\n');
    embed.addFields({ name: 'Trading Pairs', value: pairsText, inline: false });
  }

  if (blockfrost?.sampleAssets && blockfrost.sampleAssets.length > 0) {
    const assetsText = blockfrost.sampleAssets
      .slice(0, 5)
      .map((asset) => {
        const fingerprint = asset.fingerprint ? ` — \`${asset.fingerprint}\`` : '';
        return `• ${asset.displayName}${fingerprint}`;
      })
      .join('\n');
    embed.addFields({ name: 'Sample Assets', value: assetsText, inline: false });
  }

  const explorer = `https://cardanoscan.io/tokenPolicy/${policyId}`;
  const cexplorer = `https://cexplorer.io/policy/${policyId}`;
  const dexLink = dexhunter?.unit
    ? `https://app.dexhunter.io/${dexhunter.unit}`
    : `https://app.dexhunter.io/?policy=${policyId}`;

  const links = [
    `[Cardanoscan](${explorer})`,
    `[Cexplorer](${cexplorer})`,
    `[DexHunter](${dexLink})`,
  ];
  if (sourceMessageUrl) links.push(`[Source](${sourceMessageUrl})`);

  embed.addFields({ name: 'Links', value: links.join(' • '), inline: false });

  return embed;
}
