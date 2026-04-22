import axios, { AxiosInstance } from 'axios';
import { CardanoStackConfig } from '../config/cardano';
import { logger } from '../utils/logger';

interface KupoChainPoint {
  slot_no: number;
  header_hash: string;
}

interface KupoValueField {
  coins: number | string;
  assets?: Record<string, number | string>;
}

export interface KupoMatch {
  transaction_index: number;
  transaction_id: string;
  output_index: number;
  address: string;
  value: KupoValueField;
  datum_hash: string | null;
  datum_type?: string | null;
  script_hash: string | null;
  created_at: KupoChainPoint;
  spent_at: KupoChainPoint | null;
}

export interface AssetMap {
  lovelace: bigint;
  // key = `${policyHex}${assetNameHex}` (no dot, matches Blockfrost unit format)
  assets: Map<string, bigint>;
}

export interface ResolvedUtxo {
  txId: string;
  outputIndex: number;
  address: string;
  createdSlot: number;
  value: AssetMap;
}

/**
 * Converts a Kupo value blob (lovelace + `{policyId}.{assetName}` keys) into
 * the contiguous-unit form used everywhere else in the bot.
 */
export function kupoValueToAssetMap(v: KupoValueField): AssetMap {
  const out: AssetMap = { lovelace: BigInt(String(v.coins ?? 0)), assets: new Map() };
  if (v.assets) {
    for (const [key, qty] of Object.entries(v.assets)) {
      const unit = key.replace('.', '');
      out.assets.set(unit, (out.assets.get(unit) ?? 0n) + BigInt(String(qty)));
    }
  }
  return out;
}

export class KupoService {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(cfg: CardanoStackConfig) {
    this.baseUrl = cfg.kupoUrl;
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 15_000 });
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await axios.get(`${this.baseUrl}/health`, { timeout: 15_000 });
      return { ok: res.status >= 200 && res.status < 300, detail: `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, detail: err?.message ?? 'unknown error' };
    }
  }

  /**
   * Returns all currently-unspent UTxOs matching a Kupo pattern. Patterns can be
   * a bech32 address (exact), `*` (all), or `<payment>/<delegation>` hex forms.
   */
  async getUnspentUtxos(pattern: string): Promise<ResolvedUtxo[]> {
    const encoded = encodeURIComponent(pattern);
    const res = await this.http.get<KupoMatch[]>(`/matches/${encoded}?unspent`);
    return (res.data ?? []).map(mapMatchToUtxo);
  }

  /**
   * Resolves a specific UTxO (transaction output) by txId and index. Used when
   * we see a spend in a block and need the consumed output's address+value.
   * Returns null if Kupo doesn't know about it (e.g., pattern scope excludes it).
   */
  async resolveOutput(txId: string, outputIndex: number): Promise<ResolvedUtxo | null> {
    const res = await this.http.get<KupoMatch[]>(
      `/matches/*?transaction_id=${encodeURIComponent(txId)}`,
    );
    const match = (res.data ?? []).find((m) => m.output_index === outputIndex);
    return match ? mapMatchToUtxo(match) : null;
  }

  /**
   * Current set of distinct asset units ever created under a policy (as seen
   * by Kupo). Used by the cold-path policy lookup when Koios is unavailable.
   */
  async getPolicyAssetUnits(policyHex: string): Promise<string[]> {
    try {
      const res = await this.http.get<KupoMatch[]>(
        `/matches/${encodeURIComponent(`${policyHex}.*`)}?unspent`,
      );
      const units = new Set<string>();
      for (const m of res.data ?? []) {
        if (!m.value.assets) continue;
        for (const k of Object.keys(m.value.assets)) {
          const unit = k.replace('.', '');
          if (unit.toLowerCase().startsWith(policyHex.toLowerCase())) units.add(unit);
        }
      }
      return Array.from(units);
    } catch (err) {
      logger.debug('Kupo policy asset listing failed', { policyHex, err });
      return [];
    }
  }
}

function mapMatchToUtxo(m: KupoMatch): ResolvedUtxo {
  return {
    txId: m.transaction_id,
    outputIndex: m.output_index,
    address: m.address,
    createdSlot: m.created_at.slot_no,
    value: kupoValueToAssetMap(m.value),
  };
}
