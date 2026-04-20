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
  /**
   * Fully-diluted value in ADA. Sourced from the Snek pool-state `metrics.marketCap`.
   * On Cardano bonding-curve tokens supply is fully minted at launch, so MCap ≈ FDV.
   */
  fdvAda: number | null;
  curvePercent: number | null;  // 0–100, only meaningful pre-grad
  twitterUrl: string | null;
  discordUrl: string | null;
  telegramUrl: string | null;
  websiteUrl: string | null;
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
  socials?: {
    twitter?: string | null;
    x?: string | null;
    discord?: string | null;
    telegram?: string | null;
    website?: string | null;
  } | null;
}

interface CurveProgressResponse {
  percent?: string | number | null;
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

  async getAssetMeta(policyId: string, assetNameHex: string): Promise<{ ticker: string | null; logoCid: string | null } | null> {
    const asset = `${policyId}.${assetNameHex}`;
    const info = await this.fetchAssetInfo(asset);
    if (!info) return null;
    return {
      ticker: info.ticker ?? null,
      logoCid: ((info as any).logoCID ?? (info as any).logoCid) ?? null,
    };
  }

  async getStats(policyId: string, assetNameHex: string): Promise<SnekTokenStats | null> {
    const asset = `${policyId.toLowerCase()}.${assetNameHex.toLowerCase()}`;
    try {
      const [poolState, info, curve] = await Promise.all([
        this.fetchPoolState(asset),
        this.fetchAssetInfo(asset),
        this.fetchCurveProgress(asset),
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

      const curvePercent = parseCurvePercent(curve?.percent);
      const socials = info?.socials ?? null;

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
        fdvAda: marketCapLovelace != null ? marketCapLovelace / LOVELACE : null,
        curvePercent,
        twitterUrl: normalizeUrl(socials?.twitter ?? socials?.x ?? null),
        discordUrl: normalizeUrl(socials?.discord ?? null),
        telegramUrl: normalizeUrl(socials?.telegram ?? null),
        websiteUrl: normalizeUrl(socials?.website ?? null),
        hasPool,
        tokenPageUrl: `https://snek.fun/token/${asset}`,
      };
    } catch (err) {
      logger.warn(`Snek lookup failed for ${asset}`, err);
      return null;
    }
  }

  private async fetchCurveProgress(asset: string): Promise<CurveProgressResponse | null> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.get<CurveProgressResponse>('/v1/pools-feed/curve/progress', {
          params: { asset },
        });
        return response.data ?? null;
      } catch (err) {
        logger.debug(`Snek curve progress failed for ${asset}`, err);
        return null;
      }
    });
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

function parseCurvePercent(v: string | number | null | undefined): number | null {
  const n = toNumber(v);
  if (n == null) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

/**
 * Snek docs describe socials as "nullable strings" but don't pin down URL vs handle.
 * Be conservative: only surface values that are already absolute https URLs.
 * Non-URL handles are dropped rather than guessing a platform base URL.
 */
function normalizeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}
