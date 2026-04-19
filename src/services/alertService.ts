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
import { BlockfrostService } from './blockfrost';
import { DexHunterService } from './dexhunter';
import { StorageService } from './storage';

const DEBOUNCE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes per channel

type PostableChannel = TextChannel | ThreadChannel | NewsChannel;

export class AlertService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly config: LumpBotConfig,
    private readonly storage: StorageService,
    private readonly blockfrost: BlockfrostService,
    private readonly dexhunter: DexHunterService
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

      const { firstSeen, record } = this.storage.recordSighting(id);
      const tracked = this.storage.isTracked(id);

      const embed = buildPolicyEmbed({
        policyId: id,
        blockfrost: blockfrostData,
        dexhunter: dexhunterData,
        firstSeen,
        alertCount: record.alertCount,
        tracked,
        sourceMessageUrl: source.url ?? null,
      });

      await this.sendAlert(embed, { firstSeen, tracked });
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
    context: { firstSeen: boolean; tracked: boolean }
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

    await channel.send({ content, embeds: [embed], allowedMentions: { parse: ['roles'] } });
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
