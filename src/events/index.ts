import { Client } from 'discord.js';
import { BotContext } from '../botContext';
import { registerReady } from './ready';
import { registerMessageCreate } from './messageCreate';
import { registerInteractionCreate } from './interactionCreate';

export function registerEvents(client: Client, ctx: BotContext): void {
  registerReady(client, ctx);
  registerMessageCreate(client, ctx);
  registerInteractionCreate(client, ctx);
}
