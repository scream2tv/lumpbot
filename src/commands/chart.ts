import axios from 'axios';
import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { SlashCommand } from './types';
import { BotContext } from '../botContext';
import { Candle, ChartPeriod } from '../services/dexhunterChart';
import { logger } from '../utils/logger';

const LUMP_POLICY_ID = '73797786382c0832b5787a5b306f5308488f14571b7061f79396ad2c';
const LUMP_ASSET_NAME_HEX = '4c756d70';
const LUMP_UNIT = `${LUMP_POLICY_ID}${LUMP_ASSET_NAME_HEX}`;
const LUMP_TICKER = 'LUMP';
const LUMP_PURPLE = 0x8b5cf6;

interface PeriodSpec {
  label: string;
  period: ChartPeriod;
  candles: number;
  span: string;
  axisUnit: 'minute' | 'hour' | 'day';
}

const PERIODS: Record<string, PeriodSpec> = {
  '15m': { label: '15m', period: '15min', candles: 96, span: '1D', axisUnit: 'hour' },
  '1h': { label: '1h', period: '1hour', candles: 240, span: '10D', axisUnit: 'day' },
  '4h': { label: '4h', period: '4hour', candles: 180, span: '30D', axisUnit: 'day' },
  '1d': { label: '1d', period: '1day', candles: 180, span: '180D', axisUnit: 'day' },
};

const data = new SlashCommandBuilder()
  .setName('chart')
  .setDescription(`Price chart for ${LUMP_TICKER} (DexHunter OHLCV)`)
  .addStringOption((opt) =>
    opt
      .setName('period')
      .setDescription('Candle period')
      .setRequired(false)
      .addChoices(
        { name: '15m · 1D', value: '15m' },
        { name: '1h · 10D', value: '1h' },
        { name: '4h · 30D', value: '4h' },
        { name: '1d · 180D', value: '1d' }
      )
  );

function candleMs(time: number): number {
  return time > 1e12 ? time : time * 1000;
}

function formatAdaPrice(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  if (Math.abs(value) < 1) return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return value.toFixed(4);
}

function formatVolume(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0 ₳';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M ₳`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K ₳`;
  return `${value.toFixed(0)} ₳`;
}

function buildCandlestickConfig(candles: Candle[], spec: PeriodSpec): Record<string, unknown> {
  const ohlc = candles.map((c) => ({
    x: candleMs(c.time),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
  }));
  const last = candles[candles.length - 1];
  const first = candles[0];
  const changePct = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
  const arrow = changePct >= 0 ? '▲' : '▼';

  return {
    type: 'candlestick',
    data: {
      datasets: [
        {
          label: `${LUMP_TICKER}/ADA`,
          data: ohlc,
          color: {
            up: 'rgba(139,92,246,1)',
            down: 'rgba(236,72,153,1)',
            unchanged: 'rgba(160,160,160,1)',
          },
          borderColor: {
            up: 'rgba(139,92,246,1)',
            down: 'rgba(236,72,153,1)',
            unchanged: 'rgba(160,160,160,1)',
          },
        },
      ],
    },
    options: {
      layout: { padding: { top: 14, left: 10, right: 10, bottom: 10 } },
      plugins: {
        title: {
          display: true,
          text: [
            `${LUMP_TICKER}/ADA  •  ${spec.span} · ${spec.label}`,
            `Close ₳${formatAdaPrice(last.close)}   ${arrow} ${changePct.toFixed(2)}%`,
          ],
          color: '#ede9fe',
          font: { size: 14, weight: 'bold' },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: spec.axisUnit, tooltipFormat: 'MMM d, HH:mm' },
          ticks: { color: '#a78bfa', maxRotation: 0, autoSkipPadding: 20 },
          grid: { color: 'rgba(139,92,246,0.08)' },
        },
        y: {
          position: 'right',
          ticks: {
            color: '#a78bfa',
            callback: "function(v){return '₳'+Number(v).toFixed(8).replace(/0+$/,'').replace(/\\.$/,'')}",
          },
          grid: { color: 'rgba(139,92,246,0.08)' },
        },
      },
    },
  };
}

async function createChartUrl(config: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await axios.post<{ success: boolean; url: string }>(
      'https://quickchart.io/chart/create',
      {
        chart: config,
        backgroundColor: '#0d0d17',
        width: 900,
        height: 500,
        version: '4',
      },
      { timeout: 12_000 }
    );
    return res.data?.success ? res.data.url : null;
  } catch (err) {
    logger.warn('QuickChart create failed', err);
    return null;
  }
}

async function execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const key = interaction.options.getString('period') ?? '1h';
  const spec = PERIODS[key] ?? PERIODS['1h'];

  await interaction.deferReply();

  const candles = await ctx.dexhunterChart.getCandles(LUMP_UNIT, spec.period, spec.candles);

  if (candles.length === 0) {
    await interaction.editReply(`No chart data returned from DexHunter for ${LUMP_TICKER} (${spec.label}).`);
    return;
  }

  const first = candles[0];
  const last = candles[candles.length - 1];
  const changePct = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const volume = candles.reduce((sum, c) => sum + (c.volume || 0), 0);
  const arrow = changePct >= 0 ? '🟣' : '🔴';

  const [chartUrl] = await Promise.all([createChartUrl(buildCandlestickConfig(candles, spec))]);

  const swapUrl = `https://app.dexhunter.io/swaps?tokenIn=&tokenOut=${LUMP_UNIT}`;
  const snekUrl = `https://www.snek.fun/token/${LUMP_UNIT}`;

  const embed = new EmbedBuilder()
    .setColor(LUMP_PURPLE)
    .setAuthor({ name: `$${LUMP_TICKER} · LUMP/ADA` })
    .setDescription(
      [
        `**${spec.span}** · **${spec.label}**  —  ${arrow} **${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%**`,
        `[Swap on DexHunter](${swapUrl})  ·  [View on Snek.fun](${snekUrl})`,
      ].join('\n')
    )
    .addFields(
      { name: 'Close', value: `₳${formatAdaPrice(last.close)}`, inline: true },
      { name: 'High', value: `₳${formatAdaPrice(high)}`, inline: true },
      { name: 'Low', value: `₳${formatAdaPrice(low)}`, inline: true },
      { name: 'Volume', value: formatVolume(volume), inline: true },
      { name: 'Candles', value: String(candles.length), inline: true },
      { name: 'Source', value: 'DexHunter', inline: true }
    )
    .setFooter({ text: 'DexHunter OHLCV' });

  if (chartUrl) embed.setImage(chartUrl);

  const ts = new Date(candleMs(last.time));
  if (!Number.isNaN(ts.getTime())) embed.setTimestamp(ts);

  await interaction.editReply({ embeds: [embed] });
}

const command: SlashCommand = { data, execute };
export default command;
