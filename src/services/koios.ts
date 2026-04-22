import axios, { AxiosInstance } from 'axios';
import { LumpBotConfig } from '../config';
import { logger } from '../utils/logger';
import { hexToUtf8Safe } from '../utils/formatters';

export interface PolicyAssetSummary {
  policyId: string;
  totalAssets: number;
  sampleAssets: Array<{
    unit: string;
    assetName: string;
    displayName: string;
    fingerprint: string | null;
    quantity: string;
  }>;
  firstMint: {
    unit: string;
    txHash: string;
    blockHeight: number | null;
    blockTime: Date | null;
  } | null;
  totalSupplyLovelace: bigint | null;
}

interface KoiosPolicyAsset {
  policy_id: string;
  asset_name: string;
  fingerprint: string;
  minting_tx_hash: string;
  total_supply: string;
  creation_time: string;
}

interface KoiosAssetInfo {
  policy_id: string;
  asset_name: string;
  fingerprint: string;
}

export class KoiosService {
  private readonly http: AxiosInstance;

  constructor(cfg: LumpBotConfig) {
    const baseURL = cfg.koios.baseUrl.replace(/\/$/, '');
    this.http = axios.create({
      baseURL,
      timeout: 15_000,
      headers: cfg.koios.apiKey ? { Authorization: `Bearer ${cfg.koios.apiKey}` } : {},
    });
  }

  async getPolicySummary(policyId: string): Promise<PolicyAssetSummary | null> {
    try {
      const res = await this.http.get<KoiosPolicyAsset[]>('/policy_asset_info', {
        params: { _asset_policy: policyId },
      });
      const rows = res.data ?? [];
      if (rows.length === 0) {
        return { policyId, totalAssets: 0, sampleAssets: [], firstMint: null, totalSupplyLovelace: null };
      }

      const sample = rows.slice(0, 5).map((r) => ({
        unit: `${r.policy_id}${r.asset_name}`,
        assetName: r.asset_name,
        displayName: r.asset_name ? hexToUtf8Safe(r.asset_name) : '(unnamed)',
        fingerprint: r.fingerprint ?? null,
        quantity: r.total_supply,
      }));

      const earliest = rows
        .filter((r) => !!r.creation_time)
        .sort((a, b) => new Date(a.creation_time).getTime() - new Date(b.creation_time).getTime())[0];

      const firstMint = earliest
        ? {
            unit: `${earliest.policy_id}${earliest.asset_name}`,
            txHash: earliest.minting_tx_hash,
            blockHeight: null,
            blockTime: earliest.creation_time ? new Date(earliest.creation_time) : null,
          }
        : null;

      const totalSupply = sample.reduce<bigint>((acc, a) => {
        try { return acc + BigInt(a.quantity); } catch { return acc; }
      }, 0n);

      return {
        policyId,
        totalAssets: rows.length,
        sampleAssets: sample,
        firstMint,
        totalSupplyLovelace: totalSupply > 0n ? totalSupply : null,
      };
    } catch (err) {
      logger.warn('Koios policy lookup failed', { policyId, err });
      return null;
    }
  }

  async getAssetByFingerprint(fingerprint: string): Promise<{ policyId: string; unit: string } | null> {
    try {
      const res = await this.http.get<KoiosAssetInfo[]>('/asset_info', {
        params: { _asset_list: `[["${fingerprint}"]]` },
      });
      const row = res.data?.[0];
      if (!row?.policy_id) return null;
      return { policyId: row.policy_id, unit: `${row.policy_id}${row.asset_name ?? ''}` };
    } catch (err) {
      logger.debug(`Koios fingerprint lookup failed for ${fingerprint}`, err);
      return null;
    }
  }
}
