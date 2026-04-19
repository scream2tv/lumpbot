import { logger } from './logger';

interface QueueItem<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Simple token-bucket style queue that also enforces a minimum spacing between calls.
 * Used to avoid tripping Blockfrost / DexHunter rate limits.
 */
export class RateLimiter {
  private readonly queue: QueueItem<unknown>[] = [];
  private active = 0;
  private lastRunAt = 0;
  private readonly name: string;
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;

  constructor(options: { name: string; maxConcurrent?: number; minIntervalMs?: number }) {
    this.name = options.name;
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.minIntervalMs = options.minIntervalMs ?? 120;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject } as QueueItem<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active >= this.maxConcurrent) return;
    const item = this.queue.shift();
    if (!item) return;

    const now = Date.now();
    const delay = Math.max(0, this.lastRunAt + this.minIntervalMs - now);
    this.active += 1;

    setTimeout(() => {
      this.lastRunAt = Date.now();
      item
        .task()
        .then((value) => item.resolve(value))
        .catch((err) => {
          logger.debug(`RateLimiter[${this.name}] task failed`, err);
          item.reject(err);
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }, delay);
  }
}
