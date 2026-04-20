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

export interface AccountTransaction {
  txHash: string;
  blockHeight: number;
  blockTime: number;
}

export interface TxUtxoEntry {
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
}

export interface TxUtxos {
  hash: string;
  inputs: TxUtxoEntry[];
  outputs: TxUtxoEntry[];
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
  private readonly blockfrostBase: string;

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
    const networkMap: Record<string, string> = {
      mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
      preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
      preview: 'https://cardano-preview.blockfrost.io/api/v0',
    };
    this.blockfrostBase = networkMap[config.blockfrost.network] ?? networkMap['mainnet'];
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

  /**
   * Returns the bech32 stake address for a payment address, or null if
   * the address is enterprise (no stake part) or unknown to Blockfrost.
   * Throws on network / server errors.
   */
  async getStakeKeyForAddress(addr: string): Promise<string | null> {
    try {
      const res: any = await this.limiter.schedule(() => this.api.addresses(addr));
      return res?.stake_address ?? null;
    } catch (err: any) {
      if (err?.status_code === 404) return null;
      throw err;
    }
  }

  /**
   * Latest transactions for a stake account, newest first.
   * count caps at 100 per Blockfrost; we typically pass 10.
   *
   * NOTE: We bypass the SDK here because @blockfrost/blockfrost-js v5.7 does
   * not wrap the /accounts/{stake_address}/addresses/transactions REST endpoint.
   * Calling the SDK's addressesTransactions() with a stake key returns HTTP 400
   * at runtime because that method expects a payment address. We call the REST
   * API directly via axios instead.
   */
  async getAccountTransactions(
    stakeAddress: string,
    opts: { count?: number } = {},
  ): Promise<AccountTransaction[]> {
    const count = Math.min(Math.max(opts.count ?? 10, 1), 100);
    const url = `${this.blockfrostBase}/accounts/${stakeAddress}/addresses/transactions`;
    const response = await this.limiter.schedule(() =>
      axios.get<Array<{ tx_hash: string; block_height: number; block_time: number; tx_index?: number; epoch_no?: number }>>(url, {
        params: { count, order: 'desc' },
        headers: { project_id: this.config.blockfrost.apiKey },
        timeout: 15_000,
      }),
    );
    return response.data.map((r) => ({
      txHash: r.tx_hash,
      blockHeight: r.block_height,
      blockTime: r.block_time,
    }));
  }

  /**
   * All payment addresses registered under a stake key. Used for
   * membership tests when classifying tx direction.
   */
  async getAccountAddresses(stakeAddress: string): Promise<string[]> {
    const rows: any[] = await this.limiter.schedule(() =>
      this.api.accountsAddresses(stakeAddress, { count: 100 }),
    );
    return rows.map((r) => r.address);
  }

  async getTransactionUtxos(txHash: string): Promise<TxUtxos> {
    const res: any = await this.limiter.schedule(() => this.api.txsUtxos(txHash));
    return {
      hash: res.hash,
      inputs: (res.inputs ?? []).map((i: any) => ({
        address: i.address,
        amount: (i.amount ?? []).map((a: any) => ({ unit: a.unit, quantity: a.quantity })),
      })),
      outputs: (res.outputs ?? []).map((o: any) => ({
        address: o.address,
        amount: (o.amount ?? []).map((a: any) => ({ unit: a.unit, quantity: a.quantity })),
      })),
    };
  }
}

// Re-exported for downstream consumers that want to format lovelace values.
export { lovelaceToAda };
