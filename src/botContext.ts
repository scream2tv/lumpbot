import { Collection } from 'discord.js';
import { LumpBotConfig } from './config';
import { StorageService } from './services/storage';
import { BlockfrostService } from './services/blockfrost';
import { DexHunterService } from './services/dexhunter';
import { AlertService } from './services/alertService';
import type { SlashCommand } from './commands/types';

export interface BotContext {
  config: LumpBotConfig;
  storage: StorageService;
  blockfrost: BlockfrostService;
  dexhunter: DexHunterService;
  alerts: AlertService;
  commands: Collection<string, SlashCommand>;
}
