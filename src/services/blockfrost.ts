import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import axios, { AxiosInstance } from 'axios';
import { LumpBotConfig } from '../config';
import { logger } from '../utils/logger';
import { RateLimiter } from '../utils/rateLimiter';
import { hexToUtf8Safe, lovelaceToAda } from '../utils/formatters';

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

interface KoiosAssetInfo {
  policy_id: string;
  asset_name: string;
  fingerprint: string;
  minting_tx_hash: string;
  total_supply: string;
  creation_time: string;
}

export class BlockfrostService {
  private readonly api: BlockFrostAPI;
  private readonly limiter: RateLimiter;
  private readonly koios: AxiosInstance;
  private readonly koiosBaseUrl: string;

  constructor(private readonly config: LumpBotConfig) {
    this.api = new BlockFrostAPI({
      projectId: config.blockfrost.apiKey,
      network: config.blockfrost.network,
    });
    this.limiter = new RateLimiter({ name: 'blockfrost', maxConcurrent: 4, minIntervalMs: 110 });
    this.koiosBaseUrl = config.koios.baseUrl.replace(/\/$/, '');
    this.koios = axios.create({
      baseURL: this.koiosBaseUrl,
      timeout: 15_000,
      headers: config.koios.apiKey
        ? { Authorization: `Bearer ${config.koios.apiKey}` }
        : {},
    });
  }

  async getPolicySummary(policyId: string): Promise<PolicyAssetSummary | null> {
    try {
      return await this.fetchFromBlockfrost(policyId);
    } catch (err) {
      logger.warn(`Blockfrost policy lookup failed for ${policyId}, attempting Koios fallback`, err);
      try {
        return await this.fetchFromKoios(policyId);
      } catch (fallbackErr) {
        logger.error(`Koios fallback failed for ${policyId}`, fallbackErr);
        return null;
      }
    }
  }

  private async fetchFromBlockfrost(policyId: string): Promise<PolicyAssetSummary> {
    const assets = await this.limiter.schedule(() => this.api.assetsPolicyById(policyId));
    if (!assets || assets.length === 0) {
      return {
        policyId,
        totalAssets: 0,
        sampleAssets: [],
        firstMint: null,
        totalSupplyLovelace: null,
      };
    }

    const sample = assets.slice(0, 5);
    const details = await Promise.all(
      sample.map((asset) =>
        this.limiter.schedule(async () => {
          try {
            const info = await this.api.assetsById(asset.asset);
            const nameHex = info.asset_name ?? asset.asset.slice(policyId.length);
            return {
              unit: asset.asset,
              assetName: nameHex,
              displayName: nameHex ? hexToUtf8Safe(nameHex) : '(unnamed)',
              fingerprint: info.fingerprint ?? null,
              quantity: info.quantity ?? asset.quantity,
              initialMintTxHash: info.initial_mint_tx_hash ?? null,
            };
          } catch (err) {
            logger.debug(`Asset lookup failed for ${asset.asset}`, err);
            return {
              unit: asset.asset,
              assetName: asset.asset.slice(policyId.length),
              displayName: hexToUtf8Safe(asset.asset.slice(policyId.length)),
              fingerprint: null,
              quantity: asset.quantity,
              initialMintTxHash: null,
            };
          }
        })
      )
    );

    let firstMint: PolicyAssetSummary['firstMint'] = null;
    const firstWithMint = details.find((d) => d.initialMintTxHash);
    if (firstWithMint?.initialMintTxHash) {
      try {
        const tx = await this.limiter.schedule(() => this.api.txs(firstWithMint.initialMintTxHash!));
        firstMint = {
          unit: firstWithMint.unit,
          txHash: firstWithMint.initialMintTxHash!,
          blockHeight: tx.block_height ?? null,
          blockTime: tx.block_time ? new Date(tx.block_time * 1000) : null,
        };
      } catch (err) {
        logger.debug('Failed to fetch mint tx', err);
      }
    }

    const totalSupplyLovelace = details.reduce<bigint>((acc, asset) => {
      try {
        return acc + BigInt(asset.quantity);
      } catch {
        return acc;
      }
    }, 0n);

    return {
      policyId,
      totalAssets: assets.length,
      sampleAssets: details.map(({ initialMintTxHash, ...rest }) => rest),
      firstMint,
      totalSupplyLovelace: totalSupplyLovelace > 0n ? totalSupplyLovelace : null,
    };
  }

  private async fetchFromKoios(policyId: string): Promise<PolicyAssetSummary> {
    const response = await this.koios.get<KoiosAssetInfo[]>('/policy_asset_info', {
      params: { _asset_policy: policyId },
    });
    const rows = response.data ?? [];
    if (rows.length === 0) {
      return {
        policyId,
        totalAssets: 0,
        sampleAssets: [],
        firstMint: null,
        totalSupplyLovelace: null,
      };
    }

    const sample = rows.slice(0, 5).map((row) => ({
      unit: `${row.policy_id}${row.asset_name}`,
      assetName: row.asset_name,
      displayName: row.asset_name ? hexToUtf8Safe(row.asset_name) : '(unnamed)',
      fingerprint: row.fingerprint ?? null,
      quantity: row.total_supply,
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

    const totalSupply = sample.reduce<bigint>((acc, asset) => {
      try {
        return acc + BigInt(asset.quantity);
      } catch {
        return acc;
      }
    }, 0n);

    return {
      policyId,
      totalAssets: rows.length,
      sampleAssets: sample,
      firstMint,
      totalSupplyLovelace: totalSupply > 0n ? totalSupply : null,
    };
  }

  async getAssetByFingerprint(fingerprint: string): Promise<{ policyId: string; unit: string } | null> {
    try {
      const info = await this.limiter.schedule(() => this.api.assetsById(fingerprint));
      if (!info?.policy_id) return null;
      return { policyId: info.policy_id, unit: info.asset };
    } catch (err) {
      logger.debug(`Fingerprint lookup failed for ${fingerprint}`, err);
      return null;
    }
  }
}

// Re-exported for downstream consumers that want to format lovelace values.
export { lovelaceToAda };
