import axios, { AxiosInstance } from 'axios';
import { LumpBotConfig } from '../config';
import { logger } from '../utils/logger';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ChartPeriod = '15min' | '1hour' | '4hour' | '1day';

const PERIOD_SECONDS: Record<ChartPeriod, number> = {
  '15min': 15 * 60,
  '1hour': 60 * 60,
  '4hour': 4 * 60 * 60,
  '1day': 24 * 60 * 60,
};

/**
 * DexHunter Charts API (separate base URL from the main swap API).
 * POST https://charts.dhapi.io/charts
 * Body: { tokenIn, tokenOut, period, from, to }  — ADA is the empty string.
 */
export class DexHunterChartService {
  private readonly http: AxiosInstance;

  constructor(config: LumpBotConfig) {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const partnerKey = config.dexhunter.partnerId || config.dexhunter.apiKey;
    if (partnerKey) headers['X-Partner-Id'] = partnerKey;
    if (config.dexhunter.apiKey) headers['X-Api-Key'] = config.dexhunter.apiKey;

    this.http = axios.create({
      baseURL: 'https://charts.dhapi.io',
      timeout: 12_000,
      headers,
    });
  }

  async getCandles(unit: string, period: ChartPeriod, candleCount = 96): Promise<Candle[]> {
    const to = Math.floor(Date.now() / 1000);
    const from = to - PERIOD_SECONDS[period] * candleCount;
    try {
      const response = await this.http.post<{ data?: Candle[] } | Candle[]>('/charts', {
        tokenIn: '',
        tokenOut: unit,
        period,
        from,
        to,
      });
      const raw = Array.isArray(response.data) ? response.data : response.data?.data ?? [];
      return raw
        .filter((c): c is Candle => c && typeof c.close === 'number')
        .sort((a, b) => a.time - b.time);
    } catch (err) {
      logger.warn(`DexHunter chart fetch failed for ${unit} @ ${period}`, err);
      return [];
    }
  }
}
