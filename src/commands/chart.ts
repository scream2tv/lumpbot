import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { SlashCommand } from './types';
import { BotContext } from '../botContext';
import { Candle, ChartPeriod } from '../services/dexhunterChart';

const LUMP_POLICY_ID = '73797786382c0832b5787a5b306f5308488f14571b7061f79396ad2c';
const LUMP_ASSET_NAME_HEX = '4c756d70';
const LUMP_UNIT = `${LUMP_POLICY_ID}${LUMP_ASSET_NAME_HEX}`;
const LUMP_NAME = 'LUMP';

const PERIOD_CHOICES: Array<{ name: string; value: ChartPeriod }> = [
  { name: '15m', value: '15min' },
  { name: '1h', value: '1hour' },
  { name: '4h', value: '4hour' },
  { name: '1d', value: '1day' },
];

const data = new SlashCommandBuilder()
  .setName('chart')
  .setDescription(`Price chart for ${LUMP_NAME} (DexHunter OHLCV)`)
  .addStringOption((opt) =>
    opt
      .setName('period')
      .setDescription('Candle period')
      .setRequired(false)
      .addChoices(...PERIOD_CHOICES.map((c) => ({ name: c.name, value: c.value })))
  );

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  if (Math.abs(value) < 0.0001) return value.toExponential(3);
  if (Math.abs(value) < 1) return value.toFixed(6);
  return value.toFixed(4);
}

function buildQuickChartUrl(candles: Candle[], period: ChartPeriod): string {
  const labels = candles.map((c) => {
    const d = new Date(c.time * 1000);
    return period === '1day'
      ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
      : `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
  });
  const closes = candles.map((c) => c.close);

  const chart = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${LUMP_NAME}/ADA`,
          data: closes,
          borderColor: 'rgb(255,184,0)',
          backgroundColor: 'rgba(255,184,0,0.15)',
          fill: true,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.25,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: `${LUMP_NAME}/ADA — ${period}`, color: '#fff' },
        legend: { display: false },
      },
      scales: {
        x: { ticks: { color: '#bbb', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#bbb' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  };

  const payload = encodeURIComponent(JSON.stringify(chart));
  return `https://quickchart.io/chart?bkg=%230d1117&w=720&h=360&c=${payload}`;
}

async function execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const period = (interaction.options.getString('period') as ChartPeriod | null) ?? '1hour';
  await interaction.deferReply();

  const candles = await ctx.dexhunterChart.getCandles(LUMP_UNIT, period);
  if (candles.length === 0) {
    await interaction.editReply(`No chart data returned from DexHunter for ${LUMP_NAME} (${period}).`);
    return;
  }

  const first = candles[0];
  const last = candles[candles.length - 1];
  const changePct = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const volume = candles.reduce((sum, c) => sum + (c.volume || 0), 0);

  const arrow = changePct >= 0 ? '🟢' : '🔴';
  const color = changePct >= 0 ? 0x2ecc71 : 0xe74c3c;

  const embed = new EmbedBuilder()
    .setTitle(`${LUMP_NAME}/ADA — ${period}`)
    .setColor(color)
    .setImage(buildQuickChartUrl(candles, period))
    .addFields(
      { name: 'Price', value: `${formatPrice(last.close)} ₳`, inline: true },
      { name: 'Change', value: `${arrow} ${changePct.toFixed(2)}%`, inline: true },
      { name: 'Volume', value: volume.toLocaleString('en-US', { maximumFractionDigits: 0 }), inline: true },
      { name: 'High', value: `${formatPrice(high)} ₳`, inline: true },
      { name: 'Low', value: `${formatPrice(low)} ₳`, inline: true },
      { name: 'Candles', value: String(candles.length), inline: true },
    )
    .setFooter({ text: `DexHunter • ${candles.length} candles` })
    .setTimestamp(new Date(last.time * 1000));

  await interaction.editReply({ embeds: [embed] });
}

const command: SlashCommand = { data, execute };
export default command;
