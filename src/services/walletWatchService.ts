import { Client, DiscordAPIError } from 'discord.js';
import { StorageService, WalletWatch } from './storage';
import { BlockfrostService, TxUtxos } from './blockfrost';
import { SnekService } from './snek';
import { logger } from '../utils/logger';
import {
  buildBurstSummaryEmbed,
  buildGroupedMoveEmbed,
  GroupedMoveEvent,
} from '../utils/walletDmEmbed';
import { splitCardanoUnit } from '../utils/cardanoAddress';
import { hexToUtf8Safe, truncateMiddle } from '../utils/formatters';

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

export interface WalletMoveGroup {
  txHashes: string[];
  primaryTxHash: string;
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

export function groupMoves(classified: ClassifiedMove[]): WalletMoveGroup[] {
  const GROUP_WINDOW_SEC = 3;

  interface Builder {
    members: Array<{ hash: string; blockTime: number; absLovelace: bigint; assetCount: number }>;
    direction: Direction;
    blockTime: number;
    lovelaceDelta: bigint;
    totals: Map<string, bigint>;
  }

  const builders: Builder[] = [];
  for (const m of classified) {
    const last = builders[builders.length - 1];
    const absLov = m.lovelaceDelta < 0n ? -m.lovelaceDelta : m.lovelaceDelta;
    const assetCount = m.assetDeltas.length;
    const canMerge =
      last &&
      last.direction === m.direction &&
      Math.abs(last.blockTime - m.blockTime) <= GROUP_WINDOW_SEC &&
      (last.members.some((x) => x.assetCount > 0) || assetCount > 0);

    if (canMerge) {
      last.members.push({ hash: m.txHash, blockTime: m.blockTime, absLovelace: absLov, assetCount });
      last.blockTime = Math.max(last.blockTime, m.blockTime);
      last.lovelaceDelta += m.lovelaceDelta;
      for (const a of m.assetDeltas) {
        last.totals.set(a.unit, (last.totals.get(a.unit) ?? 0n) + a.quantity);
      }
    } else {
      const totals = new Map<string, bigint>();
      for (const a of m.assetDeltas) totals.set(a.unit, a.quantity);
      builders.push({
        members: [{ hash: m.txHash, blockTime: m.blockTime, absLovelace: absLov, assetCount }],
        direction: m.direction,
        blockTime: m.blockTime,
        lovelaceDelta: m.lovelaceDelta,
        totals,
      });
    }
  }

  return builders.map((b) => {
    const primary = [...b.members].sort((x, y) => {
      if (x.assetCount !== y.assetCount) return y.assetCount - x.assetCount;
      return x.absLovelace > y.absLovelace ? -1 : x.absLovelace < y.absLovelace ? 1 : 0;
    })[0];

    const assetDeltas = Array.from(b.totals.entries())
      .filter(([, q]) => q !== 0n)
      .map(([unit, quantity]) => ({ unit, quantity }))
      .sort((a, z) => {
        const aa = a.quantity < 0n ? -a.quantity : a.quantity;
        const zz = z.quantity < 0n ? -z.quantity : z.quantity;
        return aa > zz ? -1 : aa < zz ? 1 : 0;
      });

    return {
      txHashes: b.members.map((x) => x.hash),
      primaryTxHash: primary.hash,
      blockTime: b.blockTime,
      direction: b.direction,
      lovelaceDelta: b.lovelaceDelta,
      assetDeltas,
    };
  });
}

interface CacheEntry { addrs: Set<string>; at: number }
interface TickerCacheEntry { ticker: string; logoCid: string | null; at: number }

export class WalletWatchService {
  private addressCache = new Map<string, CacheEntry>();
  private tickerCache = new Map<string, TickerCacheEntry>();
  private readonly TICKER_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly storage: StorageService,
    private readonly blockfrost: BlockfrostService,
    private readonly snek: SnekService,
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

  private async resolveTicker(unit: string): Promise<{ ticker: string; logoCid: string | null }> {
    const cached = this.tickerCache.get(unit);
    if (cached && Date.now() - cached.at < this.TICKER_TTL_MS) {
      return { ticker: cached.ticker, logoCid: cached.logoCid };
    }

    const { policyId, assetNameHex } = splitCardanoUnit(unit);
    let ticker: string | null = null;
    let logoCid: string | null = null;

    try {
      const meta = await this.snek.getAssetMeta(policyId, assetNameHex);
      if (meta) {
        ticker = meta.ticker;
        logoCid = meta.logoCid;
      }
    } catch (err) {
      logger.warn('snek getAssetMeta failed', { unit, err });
    }

    if (!ticker) {
      const decoded = hexToUtf8Safe(assetNameHex);
      if (decoded && /^[\x20-\x7e]+$/.test(decoded)) ticker = decoded;
    }
    if (!ticker) ticker = `NFT ${truncateMiddle(policyId, 6, 4)}`;

    const result = { ticker, logoCid };
    this.tickerCache.set(unit, { ...result, at: Date.now() });
    return result;
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
          // Classify oldest-first
          const chrono = [...newTxs].reverse();
          const classified: ClassifiedMove[] = [];
          for (const t of chrono) {
            const utxos = await this.blockfrost.getTransactionUtxos(t.txHash);
            const c = classifyTx(utxos, mine);
            c.blockTime = t.blockTime;
            classified.push(c);
          }
          const groups = groupMoves(classified);
          for (const g of groups) {
            await this.sendGroupedMoveDm(sub, g);
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

  private async sendGroupedMoveDm(sub: WalletWatch, group: WalletMoveGroup): Promise<void> {
    const enriched = await Promise.all(
      group.assetDeltas.map(async (d) => {
        const meta = await this.resolveTicker(d.unit);
        return { unit: d.unit, quantity: d.quantity, ticker: meta.ticker, logoCid: meta.logoCid };
      }),
    );

    const otherTxHashes = group.txHashes.filter((h) => h !== group.primaryTxHash);
    const evt: GroupedMoveEvent = {
      displayAddress: sub.displayAddress,
      direction: group.direction,
      lovelaceDelta: group.lovelaceDelta,
      assetDeltas: enriched,
      primaryTxHash: group.primaryTxHash,
      otherTxHashes,
      blockTime: group.blockTime,
      cardanoscanBase: this.cardanoscanBase,
    };

    const user = await this.client.users.fetch(sub.discordUserId);
    try {
      await user.send({ embeds: [buildGroupedMoveEmbed(evt)] });
    } catch (err) {
      if (this.isDmBlockedError(err)) throw err;
      await user.send(`💸 Wallet ${this.cardanoscanBase}/transaction/${group.primaryTxHash}`);
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

