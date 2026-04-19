import axios, { AxiosInstance } from 'axios';
import { LumpBotConfig } from '../config';
import { logger } from '../utils/logger';
import { RateLimiter } from '../utils/rateLimiter';

export interface SnekTokenStats {
  asset: string;            // "{policyId}.{hexName}"
  policyId: string;
  assetNameHex: string;
  ticker: string | null;
  description: string | null;
  priceAda: number | null;      // ADA per smallest token unit (ratio-safe)
  liquidityAda: number | null;
  volumeAda: number | null;
  marketCapAda: number | null;
  hasPool: boolean;
  tokenPageUrl: string;
}

interface PoolsFeedResponse {
  pool?: {
    id?: string;
    x?: { asset?: string; amount?: string | number };
    y?: { asset?: string; amount?: string | number };
  };
  metrics?: {
    marketCap?: number | string;
    totalVolumeAda?: number | string;
    totalTxCount?: number | string;
  };
  info?: {
    asset?: string;
    ticker?: string;
    description?: string;
  };
}

interface AssetInfoResponse {
  asset?: string;
  ticker?: string;
  description?: string;
}

const LOVELACE = 1_000_000;

export class SnekService {
  private readonly http: AxiosInstance;
  private readonly limiter: RateLimiter;

  constructor(config: LumpBotConfig) {
    this.http = axios.create({
      baseURL: config.snek.baseUrl.replace(/\/$/, ''),
      timeout: 10_000,
      headers: { Accept: 'application/json' },
    });
    this.limiter = new RateLimiter({ name: 'snek', maxConcurrent: 3, minIntervalMs: 150 });
  }

  async getStats(policyId: string, assetNameHex: string): Promise<SnekTokenStats | null> {
    const asset = `${policyId.toLowerCase()}.${assetNameHex.toLowerCase()}`;
    try {
      const [poolState, info] = await Promise.all([
        this.fetchPoolState(asset),
        this.fetchAssetInfo(asset),
      ]);

      const xAmount = toNumber(poolState?.pool?.x?.amount);
      const yLovelace = toNumber(poolState?.pool?.y?.amount);
      const hasPool = xAmount != null && yLovelace != null && xAmount > 0;

      // y is ADA-side lovelace, x is token-side smallest unit. Price = ADA / token.
      const priceAda = hasPool ? (yLovelace! / LOVELACE) / xAmount! : null;
      const liquidityAda = yLovelace != null ? yLovelace / LOVELACE : null;
      const volumeLovelace = toNumber(poolState?.metrics?.totalVolumeAda);
      const marketCapLovelace = toNumber(poolState?.metrics?.marketCap);

      const ticker = info?.ticker ?? poolState?.info?.ticker ?? null;
      const description = info?.description ?? poolState?.info?.description ?? null;

      // Nothing useful came back — don't pretend we have the asset.
      if (!hasPool && !ticker) return null;

      return {
        asset,
        policyId: policyId.toLowerCase(),
        assetNameHex: assetNameHex.toLowerCase(),
        ticker,
        description,
        priceAda,
        liquidityAda,
        volumeAda: volumeLovelace != null ? volumeLovelace / LOVELACE : null,
        marketCapAda: marketCapLovelace != null ? marketCapLovelace / LOVELACE : null,
        hasPool,
        tokenPageUrl: `https://snek.fun/token/${asset}`,
      };
    } catch (err) {
      logger.warn(`Snek lookup failed for ${asset}`, err);
      return null;
    }
  }

  private async fetchPoolState(asset: string): Promise<PoolsFeedResponse | null> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.get<PoolsFeedResponse>('/v1/pools-feed/initial/state', {
          params: { asset },
        });
        return response.data ?? null;
      } catch (err) {
        logger.debug(`Snek pool state failed for ${asset}`, err);
        return null;
      }
    });
  }

  private async fetchAssetInfo(asset: string): Promise<AssetInfoResponse | null> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.get<AssetInfoResponse>('/v1/asset-info', {
          params: { asset },
        });
        return response.data ?? null;
      } catch (err) {
        logger.debug(`Snek asset-info failed for ${asset}`, err);
        return null;
      }
    });
  }
}

function toNumber(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
