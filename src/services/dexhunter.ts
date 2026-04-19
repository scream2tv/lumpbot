import axios, { AxiosInstance } from 'axios';
import { LumpBotConfig } from '../config';
import { logger } from '../utils/logger';
import { RateLimiter } from '../utils/rateLimiter';

export interface DexHunterTokenStats {
  policyId: string;
  unit: string | null;
  ticker: string | null;
  name: string | null;
  priceAda: number | null;
  priceChange24hPct: number | null;
  volume24hAda: number | null;
  liquidityAda: number | null;
  pairs: Array<{
    dex: string;
    pair: string;
    liquidityAda: number | null;
  }>;
}

interface TokenLookupResponse {
  token_id?: string;
  token_policy?: string;
  token_name?: string;
  ticker?: string;
  is_verified?: boolean;
  supply?: number;
}

interface MarketStatsResponse {
  token_id?: string;
  price?: number;
  price_ada?: number;
  priceChange?: { '24h'?: number };
  volume?: { '24h'?: number };
  tvl?: number;
  tvl_ada?: number;
  liquidity?: number;
  pairs?: Array<{
    dex?: string;
    name?: string;
    liquidity?: number;
  }>;
}

/**
 * DexHunter v3 offers public market endpoints for Cardano tokens.
 * We lookup the token by policy ID, then fetch stats and pair data.
 * Any step is best-effort – if DexHunter is down the bot still posts the Blockfrost embed.
 */
export class DexHunterService {
  private readonly http: AxiosInstance;
  private readonly limiter: RateLimiter;

  constructor(private readonly config: LumpBotConfig) {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (config.dexhunter.apiKey) headers['X-Api-Key'] = config.dexhunter.apiKey;
    if (config.dexhunter.partnerId) headers['X-Partner-Id'] = config.dexhunter.partnerId;

    this.http = axios.create({
      baseURL: config.dexhunter.baseUrl.replace(/\/$/, ''),
      timeout: 12_000,
      headers,
    });
    this.limiter = new RateLimiter({ name: 'dexhunter', maxConcurrent: 3, minIntervalMs: 150 });
  }

  async getStatsByPolicyId(policyId: string): Promise<DexHunterTokenStats | null> {
    try {
      const token = await this.lookupToken(policyId);
      if (!token) {
        return {
          policyId,
          unit: null,
          ticker: null,
          name: null,
          priceAda: null,
          priceChange24hPct: null,
          volume24hAda: null,
          liquidityAda: null,
          pairs: [],
        };
      }

      const unit = token.token_id ?? null;
      const stats = unit ? await this.fetchStats(unit) : null;

      return {
        policyId,
        unit,
        ticker: token.ticker ?? null,
        name: token.token_name ?? null,
        priceAda: stats?.price_ada ?? stats?.price ?? null,
        priceChange24hPct: stats?.priceChange?.['24h'] ?? null,
        volume24hAda: stats?.volume?.['24h'] ?? null,
        liquidityAda: stats?.tvl_ada ?? stats?.tvl ?? stats?.liquidity ?? null,
        pairs:
          stats?.pairs?.slice(0, 5).map((p) => ({
            dex: p.dex ?? 'unknown',
            pair: p.name ?? 'ADA',
            liquidityAda: p.liquidity ?? null,
          })) ?? [],
      };
    } catch (err) {
      logger.warn(`DexHunter lookup failed for ${policyId}`, err);
      return null;
    }
  }

  private async lookupToken(policyId: string): Promise<TokenLookupResponse | null> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.post<TokenLookupResponse[]>('/swap/tokens', {
          filter: [
            {
              filterType: 'POLICY',
              values: [policyId],
            },
          ],
          page: 0,
          perPage: 1,
          sort: 'MARKETCAP',
        });
        const data = Array.isArray(response.data) ? response.data : [];
        return data[0] ?? null;
      } catch (err) {
        logger.debug('DexHunter lookup fallback to GET endpoint', err);
        try {
          const response = await this.http.get<TokenLookupResponse[]>(
            `/swap/token/${policyId}`
          );
          return Array.isArray(response.data) ? response.data[0] ?? null : response.data ?? null;
        } catch (inner) {
          logger.debug('DexHunter GET token lookup failed', inner);
          return null;
        }
      }
    });
  }

  private async fetchStats(unit: string): Promise<MarketStatsResponse | null> {
    return this.limiter.schedule(async () => {
      try {
        const response = await this.http.get<MarketStatsResponse>(`/swap/token/stats/${unit}`);
        return response.data ?? null;
      } catch (err) {
        logger.debug(`DexHunter stats failed for ${unit}`, err);
        return null;
      }
    });
  }
}
