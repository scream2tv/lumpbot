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

function formatPrice(value: number, digits = 8): string {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  if (Math.abs(value) < 1) return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return value.toFixed(4);
}

async function getAdaUsd(): Promise<number | null> {
  try {
    const res = await axios.get<{ cardano?: { usd?: number } }>(
      'https://api.coingecko.com/api/v3/simple/price',
      { params: { ids: 'cardano', vs_currencies: 'usd' }, timeout: 6_000 }
    );
    return res.data?.cardano?.usd ?? null;
  } catch (err) {
    logger.debug('CoinGecko ADA/USD fetch failed', err);
    return null;
  }
}

function buildCandlestickConfig(candles: Candle[], spec: PeriodSpec, closeUsd: number | null): Record<string, unknown> {
  const ohlc = candles.map((c) => ({
    x: candleMs(c.time),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
  }));
  const volData = candles.map((c) => ({ x: candleMs(c.time), y: c.volume || 0 }));
  const volColors = candles.map((c) =>
    c.close >= c.open ? 'rgba(38,166,154,0.55)' : 'rgba(239,83,80,0.55)'
  );
  const maxVol = Math.max(1, ...volData.map((v) => v.y));
  const last = candles[candles.length - 1];
  const closeLabel = `Close ₳${formatPrice(last.close)}${closeUsd !== null ? `  ≈  $${formatPrice(last.close * closeUsd, 8)} USD` : ''}`;

  return {
    type: 'candlestick',
    data: {
      datasets: [
        {
          label: `${LUMP_TICKER}/ADA`,
          data: ohlc,
          color: {
            up: 'rgba(38,166,154,1)',
            down: 'rgba(239,83,80,1)',
            unchanged: 'rgba(160,160,160,1)',
          },
          borderColor: {
            up: 'rgba(38,166,154,1)',
            down: 'rgba(239,83,80,1)',
            unchanged: 'rgba(160,160,160,1)',
          },
          yAxisID: 'y',
        },
        {
          label: 'Vol',
          type: 'bar',
          data: volData,
          backgroundColor: volColors,
          borderColor: volColors,
          yAxisID: 'y1',
          barPercentage: 0.9,
          categoryPercentage: 1.0,
        },
      ],
    },
    options: {
      layout: { padding: { top: 10, left: 10, right: 10, bottom: 10 } },
      plugins: {
        title: {
          display: true,
          text: [`${LUMP_TICKER} • ${spec.span} • ${spec.label} candles`, closeLabel],
          color: '#e6e6e6',
          font: { size: 14 },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: spec.axisUnit, tooltipFormat: 'MMM d, HH:mm' },
          ticks: { color: '#aaa', maxRotation: 0, autoSkipPadding: 16 },
          grid: { color: 'rgba(255,255,255,0.06)' },
        },
        y: {
          position: 'left',
          ticks: { color: '#aaa' },
          grid: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: 'Price (₳)', color: '#aaa' },
        },
        y1: {
          position: 'right',
          beginAtZero: true,
          suggestedMax: maxVol * 4,
          grid: { display: false },
          ticks: { color: '#666' },
          title: { display: true, text: 'Vol (₳)', color: '#666' },
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
        backgroundColor: '#0d1117',
        width: 900,
        height: 520,
        version: '4',
      },
      { timeout: 10_000 }
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

  const [candles, adaUsd] = await Promise.all([
    ctx.dexhunterChart.getCandles(LUMP_UNIT, spec.period, spec.candles),
    getAdaUsd(),
  ]);

  if (candles.length === 0) {
    await interaction.editReply(`No chart data returned from DexHunter for ${LUMP_TICKER} (${spec.label}).`);
    return;
  }

  const first = candles[0];
  const last = candles[candles.length - 1];
  const changePct = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
  const color = changePct >= 0 ? 0x26a69a : 0xef5350;

  const chartUrl = await createChartUrl(buildCandlestickConfig(candles, spec, adaUsd));
  const swapUrl = `https://app.dexhunter.io/swaps?tokenIn=&tokenOut=${LUMP_UNIT}`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `📈  $${LUMP_TICKER}  ·  DexHunter` })
    .setDescription(`**${spec.span}** · **${spec.label}** · [Swap on DexHunter](${swapUrl})`)
    .setFooter({ text: 'DexHunter charts · CoinGecko ADA/USD' });

  if (chartUrl) embed.setImage(chartUrl);

  const ts = new Date(candleMs(last.time));
  if (!Number.isNaN(ts.getTime())) embed.setTimestamp(ts);

  await interaction.editReply({ embeds: [embed] });
}

const command: SlashCommand = { data, execute };
export default command;
