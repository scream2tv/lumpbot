import { Collection } from 'discord.js';
import { LumpBotConfig } from './config';
import { StorageService } from './services/storage';
import { BlockfrostService } from './services/blockfrost';
import { DexHunterService } from './services/dexhunter';
import { DexHunterChartService } from './services/dexhunterChart';
import { SnekService } from './services/snek';
import { AlertService } from './services/alertService';
import { WalletWatchService } from './services/walletWatchService';
import { WalletWatcher } from './services/walletWatcher';
import type { SlashCommand } from './commands/types';

export interface BotContext {
  config: LumpBotConfig;
  storage: StorageService;
  blockfrost: BlockfrostService;
  dexhunter: DexHunterService;
  dexhunterChart: DexHunterChartService;
  snek: SnekService;
  alerts: AlertService;
  walletWatchService: WalletWatchService;
  walletWatcher: WalletWatcher;
  commands: Collection<string, SlashCommand>;
}
