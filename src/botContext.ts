import { Collection } from 'discord.js';
import { LumpBotConfig } from './config';
import { StorageService } from './services/storage';
import { KupoService } from './services/kupo';
import { OgmiosClient } from './services/ogmios';
import { KoiosService } from './services/koios';
import { DexHunterService } from './services/dexhunter';
import { DexHunterChartService } from './services/dexhunterChart';
import { SnekService } from './services/snek';
import { AlertService } from './services/alertService';
import { WalletStreamService } from './services/walletStreamService';
import type { SlashCommand } from './commands/types';

export interface BotContext {
  config: LumpBotConfig;
  storage: StorageService;
  kupo: KupoService;
  ogmios: OgmiosClient;
  koios: KoiosService;
  dexhunter: DexHunterService;
  dexhunterChart: DexHunterChartService;
  snek: SnekService;
  alerts: AlertService;
  walletStream: WalletStreamService;
  commands: Collection<string, SlashCommand>;
}
