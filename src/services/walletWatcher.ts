import { StorageService } from './storage';
import { WalletWatchService } from './walletWatchService';
import { logger } from '../utils/logger';

export class WalletWatcher {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly storage: StorageService,
    private readonly svc: WalletWatchService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    logger.info('WalletWatcher started', { intervalMs: this.intervalMs });
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const stakeKeys = this.storage.distinctWatchedStakeKeys();
      for (const stakeKey of stakeKeys) {
        try {
          await this.svc.checkWallet(stakeKey);
        } catch (err) {
          logger.warn('wallet poll failed, continuing', { stakeKey, err });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
