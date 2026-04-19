import axios from 'axios';
import {
  Client,
  EmbedBuilder,
  Message,
  TextChannel,
  ThreadChannel,
  NewsChannel,
} from 'discord.js';
import { LumpBotConfig } from '../config';
import { logger } from '../utils/logger';
import { buildPolicyEmbed } from '../utils/embedBuilder';
import { buildAlertComponents } from '../utils/components';
import { BlockfrostService } from './blockfrost';
import { DexHunterService } from './dexhunter';
import { SnekService, SnekTokenStats } from './snek';
import { PriceSource, StorageService } from './storage';

const DEBOUNCE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes per channel

type PostableChannel = TextChannel | ThreadChannel | NewsChannel;

export class AlertService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly config: LumpBotConfig,
    private readonly storage: StorageService,
    private readonly blockfrost: BlockfrostService,
    private readonly dexhunter: DexHunterService,
    private readonly snek: SnekService
  ) {}

  async handlePolicyDetection(policyId: string, source: Message): Promise<void> {
    const id = policyId.toLowerCase();
    const channelId = source.channelId;

    if (this.storage.isRecentlyAlerted(id, channelId, DEBOUNCE_WINDOW_MS)) {
      logger.debug(`Debounced duplicate alert for ${id} in channel ${channelId}`);
      return;
    }

    const key = `${id}:${channelId}`;
    if (this.inFlight.has(key)) {
      logger.debug(`Alert already in flight for ${key}`);
      return;
    }
    this.inFlight.add(key);

    try {
      const [blockfrostData, dexhunterData] = await Promise.all([
        this.blockfrost.getPolicySummary(id),
        this.dexhunter.getStatsByPolicyId(id),
      ]);

      // Derive an asset name hex from DexHunter's unit or the first non-metadata blockfrost sample.
      const assetNameHex = resolveAssetNameHex(id, dexhunterData?.unit ?? null, blockfrostData);
      const snekData: SnekTokenStats | null = assetNameHex
        ? await this.snek.getStats(id, assetNameHex)
        : null;

      const { firstSeen, record } = this.storage.recordSighting(id);
      const tracked = this.storage.isTracked(id);

      const { price: callPrice, fdv: callFdv, source: callSource, unit: callUnit } = pickCallSnapshot(
        dexhunterData,
        snekData,
        assetNameHex
      );

      const callerDisplayName =
        (source.member?.displayName ?? source.author.globalName ?? source.author.username) || 'unknown';
      const { record: call } = this.storage.recordCall({
        policyId: id,
        guildId: source.guildId ?? '',
        channelId: source.channelId,
        messageId: source.id,
        callerUserId: source.author.id,
        callerDisplayName,
        calledAt: new Date().toISOString(),
        callPriceAda: callPrice,
        callFdvAda: callFdv,
        callUnit,
        callSource,
      });

      const embed = buildPolicyEmbed({
        policyId: id,
        blockfrost: blockfrostData,
        dexhunter: dexhunterData,
        snek: snekData,
        firstSeen,
        alertCount: record.alertCount,
        tracked,
        sourceMessageUrl: source.url ?? null,
        call,
      });

      await this.sendAlert(embed, { firstSeen, tracked, policyId: id });
      this.storage.markAlerted(id, channelId);

      if (this.config.integrations.externalWebhookUrl) {
        this.forwardWebhook({
          policyId: id,
          firstSeen,
          tracked,
          blockfrost: blockfrostData,
          dexhunter: dexhunterData,
          source: source.url,
        }).catch((err) => logger.warn('External webhook delivery failed', err));
      }
    } catch (err) {
      logger.error(`Failed to process policy ${id}`, err);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async sendAlert(
    embed: EmbedBuilder,
    context: { firstSeen: boolean; tracked: boolean; policyId: string }
  ): Promise<void> {
    const channelId = this.config.discord.alertChannelId;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !this.isPostable(channel)) {
      logger.error(`Alert channel ${channelId} is not a postable text/thread channel`);
      return;
    }

    const content =
      context.firstSeen && this.config.discord.alphaRoleId
        ? `<@&${this.config.discord.alphaRoleId}> alpha alert – first-ever sighting!`
        : context.tracked
          ? 'Tracked policy ID sighted.'
          : undefined;

    await channel.send({
      content,
      embeds: [embed],
      components: [buildAlertComponents(context.policyId)],
      allowedMentions: { parse: ['roles'] },
    });
  }

  /** Re-fetches stats for an existing policy without touching sighting/debounce tables. Used by the Refresh button. */
  async buildRefreshedEmbed(policyId: string): Promise<EmbedBuilder | null> {
    const id = policyId.toLowerCase();
    const [blockfrostData, dexhunterData] = await Promise.all([
      this.blockfrost.getPolicySummary(id),
      this.dexhunter.getStatsByPolicyId(id),
    ]);
    const assetNameHex = resolveAssetNameHex(id, dexhunterData?.unit ?? null, blockfrostData);
    const snekData = assetNameHex ? await this.snek.getStats(id, assetNameHex) : null;

    const call = this.storage.getCall(id);
    const tracked = this.storage.isTracked(id);
    const sighting = this.storage.getSighting(id);

    return buildPolicyEmbed({
      policyId: id,
      blockfrost: blockfrostData,
      dexhunter: dexhunterData,
      snek: snekData,
      firstSeen: false,
      alertCount: sighting?.alertCount ?? 0,
      tracked,
      sourceMessageUrl: null,
      call,
    });
  }

  private isPostable(channel: unknown): channel is PostableChannel {
    return (
      channel instanceof TextChannel ||
      channel instanceof ThreadChannel ||
      channel instanceof NewsChannel
    );
  }

  private async forwardWebhook(payload: unknown): Promise<void> {
    const url = this.config.integrations.externalWebhookUrl;
    if (!url) return;
    await axios.post(url, payload, { timeout: 7_000 });
  }
}

function resolveAssetNameHex(
  policyId: string,
  dexhunterUnit: string | null,
  blockfrost: Awaited<ReturnType<BlockfrostService['getPolicySummary']>>
): string | null {
  const fromDex = extractNameFromUnit(policyId, dexhunterUnit);
  if (fromDex) return fromDex;
  const sample =
    blockfrost?.sampleAssets.find((a) => !/metadata/i.test(a.displayName)) ??
    blockfrost?.sampleAssets[0];
  return extractNameFromUnit(policyId, sample?.unit ?? null);
}

function extractNameFromUnit(policyId: string, unit: string | null): string | null {
  if (!unit) return null;
  const normalized = unit.replace(/\./g, '').toLowerCase();
  const pid = policyId.toLowerCase();
  if (!normalized.startsWith(pid) || normalized.length <= pid.length) return null;
  return normalized.slice(pid.length);
}

function pickCallSnapshot(
  dex: { priceAda: number | null; unit: string | null } | null,
  snek: SnekTokenStats | null,
  assetNameHex: string | null
): { price: number | null; fdv: number | null; source: PriceSource; unit: string | null } {
  const fdv = snek?.fdvAda ?? null;
  if (dex?.priceAda != null) {
    return { price: dex.priceAda, fdv, source: 'dexhunter', unit: dex.unit ?? null };
  }
  if (snek?.priceAda != null) {
    return { price: snek.priceAda, fdv, source: 'snek', unit: snek.policyId + (assetNameHex ?? '') };
  }
  const fallbackUnit = dex?.unit ?? (snek && assetNameHex ? snek.policyId + assetNameHex : null);
  return { price: null, fdv, source: null, unit: fallbackUnit };
}
