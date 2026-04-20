import { Client, DiscordAPIError } from 'discord.js';
import { StorageService, WalletWatch } from './storage';
import { BlockfrostService, TxUtxos } from './blockfrost';
import { DexHunterService } from './dexhunter';
import { logger } from '../utils/logger';
import {
  buildWalletMoveEmbed,
  buildWalletMovePlaintext,
  buildBurstSummaryEmbed,
  WalletMoveEvent,
} from '../utils/walletDmEmbed';

const DM_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PER_WALLET_COOLDOWN_MS = 30_000;
const BURST_COLLAPSE_THRESHOLD = 3;
const ADDRESS_CACHE_TTL_MS = 60 * 60 * 1000;

export type Direction = 'IN' | 'OUT' | 'SELF';

export interface AssetDelta {
  unit: string;
  quantity: bigint;
}

export interface ClassifiedMove {
  txHash: string;
  blockTime: number;
  direction: Direction;
  lovelaceDelta: bigint;
  assetDeltas: AssetDelta[];
}

export function classifyTx(utxos: TxUtxos, mine: Set<string>): ClassifiedMove {
  const inputsMine = utxos.inputs.some((i) => mine.has(i.address));
  const outputsMine = utxos.outputs.some((o) => mine.has(o.address));

  let direction: Direction;
  if (inputsMine && outputsMine) direction = 'SELF';
  else if (inputsMine) direction = 'OUT';
  else direction = 'IN';

  const totals = new Map<string, bigint>();
  const addTotal = (unit: string, qty: bigint) => {
    totals.set(unit, (totals.get(unit) ?? 0n) + qty);
  };
  for (const o of utxos.outputs) {
    if (!mine.has(o.address)) continue;
    for (const a of o.amount) addTotal(a.unit, BigInt(a.quantity));
  }
  for (const i of utxos.inputs) {
    if (!mine.has(i.address)) continue;
    for (const a of i.amount) addTotal(a.unit, -BigInt(a.quantity));
  }

  const lovelaceDelta = totals.get('lovelace') ?? 0n;
  totals.delete('lovelace');
  const assetDeltas: AssetDelta[] = Array.from(totals.entries())
    .filter(([, q]) => q !== 0n)
    .map(([unit, quantity]) => ({ unit, quantity }))
    .sort((a, b) => {
      const aa = a.quantity < 0n ? -a.quantity : a.quantity;
      const bb = b.quantity < 0n ? -b.quantity : b.quantity;
      return aa > bb ? -1 : aa < bb ? 1 : 0;
    });

  return { txHash: utxos.hash, blockTime: 0, direction, lovelaceDelta, assetDeltas };
}

interface CacheEntry { addrs: Set<string>; at: number }

export class WalletWatchService {
  private addressCache = new Map<string, CacheEntry>();

  constructor(
    private readonly storage: StorageService,
    private readonly blockfrost: BlockfrostService,
    private readonly dexhunter: DexHunterService,
    private readonly client: Client,
    private readonly cardanoscanBase: string,
  ) {}

  async baselineTxHashFor(stakeKey: string): Promise<string | null> {
    const txs = await this.blockfrost.getAccountTransactions(stakeKey, { count: 1 });
    return txs[0]?.txHash ?? null;
  }

  // checkWallet + helpers added in Task 9
}
