import { Client, Events, Message } from 'discord.js';
import { BotContext } from '../botContext';
import { extractPolicyIds, extractAssetFingerprints } from '../utils/regex';
import { logger } from '../utils/logger';

export function registerMessageCreate(client: Client, ctx: BotContext): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author.bot) return;
      if (!message.guild) return;

      const monitored = ctx.config.discord.monitoredChannelIds;
      if (monitored.length > 0 && !monitored.includes(message.channelId)) {
        return;
      }

      const content = message.content ?? '';
      if (content.length === 0) return;

      const policyIds = extractPolicyIds(content);

      if (policyIds.length === 0) {
        const fingerprints = extractAssetFingerprints(content);
        if (fingerprints.length === 0) return;

        for (const fingerprint of fingerprints.slice(0, 3)) {
          const resolved = await ctx.blockfrost.getAssetByFingerprint(fingerprint);
          if (resolved?.policyId) policyIds.push(resolved.policyId.toLowerCase());
        }
      }

      const unique = Array.from(new Set(policyIds)).slice(0, 3);
      for (const policyId of unique) {
        await ctx.alerts.handlePolicyDetection(policyId, message);
      }
    } catch (err) {
      logger.error('Error handling messageCreate', err);
    }
  });
}
