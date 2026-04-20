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

  private async getMineAddresses(watch: WalletWatch): Promise<Set<string>> {
    if (watch.isEnterprise) return new Set([watch.displayAddress]);

    const cached = this.addressCache.get(watch.stakeKey);
    if (cached && Date.now() - cached.at < ADDRESS_CACHE_TTL_MS) {
      return cached.addrs;
    }
    const addrs = await this.blockfrost.getAccountAddresses(watch.stakeKey);
    const set = new Set(addrs);
    this.addressCache.set(watch.stakeKey, { addrs: set, at: Date.now() });
    return set;
  }

  private isDmBlockedError(err: unknown): boolean {
    if (err instanceof DiscordAPIError) {
      return err.code === 50007; // Cannot send messages to this user
    }
    return false;
  }

  async checkWallet(stakeKey: string): Promise<void> {
    const subs = this.storage.getWatchesForStakeKey(stakeKey);
    if (subs.length === 0) return;

    let txs;
    try {
      txs = await this.blockfrost.getAccountTransactions(stakeKey, { count: 10 });
    } catch (err) {
      logger.warn('getAccountTransactions failed', { stakeKey, err });
      return;
    }
    if (txs.length === 0) return;

    const newest = txs[0];

    for (const sub of subs) {
      const now = Date.now();
      if (sub.dmDisabledUntil && now < sub.dmDisabledUntil) continue;
      if (sub.lastNotifiedAt && now < sub.lastNotifiedAt + PER_WALLET_COOLDOWN_MS) continue;

      const cursorIdx = sub.lastNotifiedTxHash
        ? txs.findIndex((t) => t.txHash === sub.lastNotifiedTxHash)
        : -1;
      const newTxs = cursorIdx < 0 ? txs : txs.slice(0, cursorIdx);
      if (newTxs.length === 0) continue;

      try {
        if (newTxs.length > BURST_COLLAPSE_THRESHOLD) {
          await this.sendBurstSummary(sub, newTxs.length, newest.txHash);
        } else {
          const mine = await this.getMineAddresses(sub);
          // oldest-first so the cursor advances monotonically
          for (const t of [...newTxs].reverse()) {
            await this.sendMoveDm(sub, mine, t.txHash, t.blockTime);
          }
        }
        this.storage.updateWatchAfterNotify(sub.id, newest.txHash, Date.now());
      } catch (err) {
        if (this.isDmBlockedError(err)) {
          logger.info('DMs blocked, cooling down 24h', {
            userId: sub.discordUserId,
            stakeKey,
          });
          this.storage.setWatchDmCooldown(sub.id, Date.now() + DM_COOLDOWN_MS);
        } else {
          logger.warn('DM dispatch failed', { subId: sub.id, err });
        }
      }
    }
  }

  private async sendMoveDm(
    sub: WalletWatch,
    mine: Set<string>,
    txHash: string,
    blockTime: number,
  ): Promise<void> {
    const utxos = await this.blockfrost.getTransactionUtxos(txHash);
    const classified = classifyTx(utxos, mine);
    const evt: WalletMoveEvent = {
      displayAddress: sub.displayAddress,
      direction: classified.direction,
      lovelaceDelta: classified.lovelaceDelta,
      assetDeltas: classified.assetDeltas.slice(0, 3),
      txHash,
      blockTime,
      cardanoscanBase: this.cardanoscanBase,
    };

    const user = await this.client.users.fetch(sub.discordUserId);
    try {
      await user.send({ embeds: [buildWalletMoveEmbed(evt)] });
    } catch (err) {
      if (this.isDmBlockedError(err)) throw err;
      // Embed failure but user reachable — fall back to plaintext once.
      await user.send(buildWalletMovePlaintext(evt));
    }
  }

  private async sendBurstSummary(
    sub: WalletWatch,
    count: number,
    latestTxHash: string,
  ): Promise<void> {
    const user = await this.client.users.fetch(sub.discordUserId);
    await user.send({
      embeds: [buildBurstSummaryEmbed(sub.displayAddress, count, latestTxHash, this.cardanoscanBase)],
    });
  }
}
