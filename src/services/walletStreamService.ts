import { Client, DiscordAPIError } from 'discord.js';
import { StorageService, WalletWatch } from './storage';
import { KupoService } from './kupo';
import { OgmiosClient, OgmiosBlock, OgmiosTransaction } from './ogmios';
import { SnekService } from './snek';
import { DexHunterService } from './dexhunter';
import { logger } from '../utils/logger';
import { slotToUnix } from '../utils/cardanoSlot';
import {
  parseCardanoAddress,
  splitCardanoUnit,
} from '../utils/cardanoAddress';
import {
  buildGroupedMoveEmbed,
  GroupedMoveEvent,
} from '../utils/walletDmEmbed';
import { hexToUtf8Safe, truncateMiddle } from '../utils/formatters';
import { CardanoStackConfig } from '../config/cardano';

const DM_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DISPATCH_DEDUPE_TTL_MS = 30 * 60 * 1000;

type Direction = 'IN' | 'OUT' | 'SELF';

interface ShadowUtxo {
  address: string;
  lovelace: bigint;
  assets: Map<string, bigint>;
  watchKey: string;
}

interface TickerCacheEntry {
  ticker: string;
  logoCid: string | null;
  dhUnit: string | null;
  snekUnit: string | null;
  at: number;
}

interface PerTxAgg {
  txId: string;
  slot: number;
  inLovelace: bigint;
  outLovelace: bigint;
  assets: Map<string, bigint>;
  fee: bigint;
  hasScriptOutput: boolean;
}

/**
 * watchKey identifies a unique wallet-level subscription target (as opposed
 * to a DB row — two users watching the same wallet share a watchKey). Base
 * addresses use their stake credential; enterprise addresses use the raw
 * bech32.
 */
function watchKeyFor(watch: WalletWatch): string {
  if (watch.isEnterprise) return `e:${watch.displayAddress.toLowerCase()}`;
  return `s:${watch.stakeKey.toLowerCase()}`;
}

function utxoKey(txId: string, idx: number): string {
  return `${txId}#${idx}`;
}

function isScriptAddress(addr: string): boolean {
  return (
    addr.startsWith('addr1w') ||
    addr.startsWith('addr1z') ||
    addr.startsWith('addr_test1w') ||
    addr.startsWith('addr_test1z')
  );
}

function classifyDirection(inLov: bigint, outLov: bigint, touchedIn: boolean, touchedOut: boolean): Direction {
  if (touchedIn && touchedOut) return 'SELF';
  if (touchedIn) return 'OUT';
  return 'IN';
}

function watchKeyForAddress(addr: string): { key: string | null; enterpriseCandidate: string | null } {
  const parsed = parseCardanoAddress(addr);
  if (!parsed) return { key: null, enterpriseCandidate: null };
  if (parsed.stakeCredHex) return { key: `s:${parsed.stakeCredHex.toLowerCase()}`, enterpriseCandidate: null };
  if (parsed.kind === 'enterprise') return { key: null, enterpriseCandidate: `e:${addr.toLowerCase()}` };
  return { key: null, enterpriseCandidate: null };
}

export class WalletStreamService {
  private shadow = new Map<string, ShadowUtxo>();
  /** watchKey → list of DB subscriptions (may be multiple users on same wallet). */
  private subscribers = new Map<string, WalletWatch[]>();
  /** Enterprise addresses we're watching (keyed as `e:<lowercase addr>`). */
  private enterpriseKeys = new Set<string>();
  private tickerCache = new Map<string, TickerCacheEntry>();
  private readonly TICKER_TTL_MS = 5 * 60 * 1000;
  /** `${watchId}:${txId}` → dispatched-at ms. Lets us fire on mempool then skip the duplicate block event. */
  private dispatchedKeys = new Map<string, number>();
  private running = false;

  constructor(
    private readonly storage: StorageService,
    private readonly kupo: KupoService,
    private readonly ogmios: OgmiosClient,
    private readonly snek: SnekService,
    private readonly dexhunter: DexHunterService,
    private readonly client: Client,
    private readonly cardanoStack: CardanoStackConfig,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const all = this.storage.distinctWatchedStakeKeys().flatMap((sk) => this.storage.getWatchesForStakeKey(sk));
    for (const w of all) this.indexWatch(w);

    logger.info('WalletStreamService: bootstrapping shadow UTxO set', {
      wallets: this.subscribers.size,
    });
    await Promise.all(Array.from(this.subscribers.keys()).map((k) => this.bootstrapKey(k)));
    logger.info('WalletStreamService: bootstrap complete', { utxos: this.shadow.size });

    this.ogmios.on('block', (b: OgmiosBlock) => void this.onBlock(b));
    this.ogmios.on('tx', (tx: OgmiosTransaction) => void this.onMempoolTx(tx));
    this.ogmios.on('rollback', (p) => {
      logger.warn('Ogmios rollback; rebootstrapping', p);
      void this.rebootstrap();
    });
    await this.ogmios.start();
  }

  stop(): void {
    this.running = false;
    this.ogmios.stop();
  }

  /** Called from /watch add once the DB row exists. Bootstraps that wallet's UTxOs. */
  async onWatchAdded(watch: WalletWatch): Promise<void> {
    this.indexWatch(watch);
    await this.bootstrapKey(watchKeyFor(watch));
  }

  /** Called from /watch remove after the DB row is gone. Cleans indexes if no other user still watches. */
  onWatchRemoved(watch: WalletWatch): void {
    const key = watchKeyFor(watch);
    const remaining = (this.subscribers.get(key) ?? []).filter((w) => w.id !== watch.id);
    if (remaining.length === 0) {
      this.subscribers.delete(key);
      if (watch.isEnterprise) this.enterpriseKeys.delete(key);
      for (const [utxoK, u] of this.shadow) {
        if (u.watchKey === key) this.shadow.delete(utxoK);
      }
    } else {
      this.subscribers.set(key, remaining);
    }
  }

  private indexWatch(watch: WalletWatch): void {
    const key = watchKeyFor(watch);
    const list = this.subscribers.get(key) ?? [];
    if (!list.find((w) => w.id === watch.id)) list.push(watch);
    this.subscribers.set(key, list);
    if (watch.isEnterprise) this.enterpriseKeys.add(key);
  }

  private async bootstrapKey(key: string): Promise<void> {
    const subs = this.subscribers.get(key);
    if (!subs || subs.length === 0) return;
    const sample = subs[0];
    const pattern = sample.isEnterprise ? sample.displayAddress : `*/${credFromStake(sample.stakeKey)}`;
    try {
      const utxos = await this.kupo.getUnspentUtxos(pattern);
      for (const u of utxos) {
        this.shadow.set(utxoKey(u.txId, u.outputIndex), {
          address: u.address,
          lovelace: u.value.lovelace,
          assets: u.value.assets,
          watchKey: key,
        });
      }
      logger.debug('bootstrapKey done', { key, count: utxos.length });
    } catch (err) {
      logger.warn('Kupo bootstrap failed', { key, err });
    }
  }

  private async rebootstrap(): Promise<void> {
    this.shadow.clear();
    await Promise.all(Array.from(this.subscribers.keys()).map((k) => this.bootstrapKey(k)));
  }

  private async onBlock(block: OgmiosBlock): Promise<void> {
    if (block.transactions.length === 0) return;
    const blockTime = slotToUnix(block.slot, this.cardanoStack.network);
    for (const tx of block.transactions) {
      await this.processTx(tx, { blockTime, mutateShadow: true });
    }
  }

  /**
   * Mempool handler. Fires as soon as the node sees an unconfirmed tx. We
   * classify using the current shadow (read-only) and dispatch a DM
   * immediately. Shadow is not mutated so a dropped mempool tx can't
   * corrupt subsequent block-event classification.
   */
  private async onMempoolTx(tx: OgmiosTransaction): Promise<void> {
    await this.processTx(tx, { blockTime: Math.floor(Date.now() / 1000), mutateShadow: false });
  }

  private async processTx(
    tx: OgmiosTransaction,
    opts: { blockTime: number; mutateShadow: boolean },
  ): Promise<void> {
    const per = new Map<string, PerTxAgg>();
    const touchedIn = new Set<string>();
    const touchedOut = new Set<string>();

    for (const input of tx.inputs) {
      const k = utxoKey(input.txId, input.index);
      const u = this.shadow.get(k);
      if (!u) continue;
      if (opts.mutateShadow) this.shadow.delete(k);
      touchedIn.add(u.watchKey);
      const agg = this.ensureAgg(per, u.watchKey, tx.id, 0);
      agg.inLovelace += u.lovelace;
      subtractAssets(agg.assets, u.assets);
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const out = tx.outputs[i];
      const { key, enterpriseCandidate } = watchKeyForAddress(out.address);
      const hit =
        (key && this.subscribers.has(key)) ? key :
        (enterpriseCandidate && this.enterpriseKeys.has(enterpriseCandidate)) ? enterpriseCandidate :
        null;
      if (!hit) continue;
      touchedOut.add(hit);
      const agg = this.ensureAgg(per, hit, tx.id, 0);
      agg.outLovelace += out.value.lovelace;
      addAssets(agg.assets, out.value.assets);
      if (isScriptAddress(out.address)) agg.hasScriptOutput = true;
      if (opts.mutateShadow) {
        this.shadow.set(utxoKey(tx.id, i), {
          address: out.address,
          lovelace: out.value.lovelace,
          assets: out.value.assets,
          watchKey: hit,
        });
      }
    }

    if (per.size === 0) return;

    for (const [key, agg] of per) {
      agg.fee = tx.fee;
      const subs = this.subscribers.get(key);
      if (!subs || subs.length === 0) continue;
      const direction = classifyDirection(
        agg.inLovelace, agg.outLovelace,
        touchedIn.has(key), touchedOut.has(key),
      );
      const lovelaceDelta = agg.outLovelace - agg.inLovelace;
      const assetDeltas = Array.from(agg.assets.entries())
        .filter(([, q]) => q !== 0n)
        .map(([unit, quantity]) => ({ unit, quantity }))
        .sort((a, b) => {
          const aa = a.quantity < 0n ? -a.quantity : a.quantity;
          const bb = b.quantity < 0n ? -b.quantity : b.quantity;
          return aa > bb ? -1 : aa < bb ? 1 : 0;
        });

      logger.info('watched wallet activity', {
        source: opts.mutateShadow ? 'block' : 'mempool',
        direction,
        txId: tx.id,
        subs: subs.length,
        lovelaceDelta: lovelaceDelta.toString(),
        assets: assetDeltas.length,
      });
      await Promise.all(
        subs.map((sub) =>
          this.dispatch(sub, {
            txId: tx.id, blockTime: opts.blockTime, direction,
            lovelaceDelta, assetDeltas, fee: agg.fee,
            hasScriptOutput: agg.hasScriptOutput,
          }),
        ),
      );
    }
  }

  private pruneDispatchedKeys(): void {
    if (this.dispatchedKeys.size < 5_000) return;
    const cutoff = Date.now() - DISPATCH_DEDUPE_TTL_MS;
    for (const [k, ts] of this.dispatchedKeys) {
      if (ts < cutoff) this.dispatchedKeys.delete(k);
    }
  }

  private ensureAgg(per: Map<string, PerTxAgg>, key: string, txId: string, slot: number): PerTxAgg {
    let a = per.get(key);
    if (a) return a;
    a = {
      txId, slot,
      inLovelace: 0n, outLovelace: 0n,
      assets: new Map(), fee: 0n, hasScriptOutput: false,
    };
    per.set(key, a);
    return a;
  }

  private async dispatch(
    sub: WalletWatch,
    m: {
      txId: string; blockTime: number; direction: Direction;
      lovelaceDelta: bigint; assetDeltas: Array<{ unit: string; quantity: bigint }>;
      fee: bigint; hasScriptOutput: boolean;
    },
  ): Promise<void> {
    const now = Date.now();
    const dedupeKey = `${sub.id}:${m.txId}`;
    if (this.dispatchedKeys.has(dedupeKey)) return;
    if (sub.dmDisabledUntil && now < sub.dmDisabledUntil) return;
    this.dispatchedKeys.set(dedupeKey, now);
    this.pruneDispatchedKeys();

    const enriched = await Promise.all(
      m.assetDeltas.map(async (d) => {
        const meta = await this.resolveTicker(d.unit);
        return {
          unit: d.unit,
          quantity: d.quantity,
          ticker: meta.ticker,
          logoCid: meta.logoCid,
          dhUnit: meta.dhUnit,
          snekUnit: meta.snekUnit,
        };
      }),
    );

    const evt: GroupedMoveEvent = {
      displayAddress: sub.displayAddress,
      label: sub.label,
      direction: m.direction,
      lovelaceDelta: m.lovelaceDelta,
      feeLovelace: m.fee,
      assetDeltas: enriched,
      primaryTxHash: m.txId,
      otherTxHashes: [],
      blockTime: m.blockTime,
      cardanoscanBase: this.cardanoStack.cardanoscanBase,
      hasScriptOutput: m.hasScriptOutput,
    };

    try {
      const user = await this.client.users.fetch(sub.discordUserId);
      await user.send({ embeds: [buildGroupedMoveEmbed(evt)] });
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 50007) {
        logger.info('DMs blocked, cooling down 24h', { userId: sub.discordUserId });
        this.storage.setWatchDmCooldown(sub.id, Date.now() + DM_COOLDOWN_MS);
      } else {
        logger.warn('DM dispatch failed', { subId: sub.id, err });
      }
    }
  }

  private async resolveTicker(unit: string): Promise<{ ticker: string; logoCid: string | null; dhUnit: string | null; snekUnit: string | null }> {
    const cached = this.tickerCache.get(unit);
    if (cached && Date.now() - cached.at < this.TICKER_TTL_MS) {
      return { ticker: cached.ticker, logoCid: cached.logoCid, dhUnit: cached.dhUnit, snekUnit: cached.snekUnit };
    }
    const { policyId, assetNameHex } = splitCardanoUnit(unit);
    let ticker: string | null = null;
    let logoCid: string | null = null;
    let dhUnit: string | null = null;
    let snekUnit: string | null = null;

    try {
      const meta = await this.snek.getAssetMeta(policyId, assetNameHex);
      if (meta) {
        ticker = meta.ticker;
        logoCid = meta.logoCid;
        snekUnit = `${policyId}${assetNameHex}`;
      }
    } catch (err) {
      logger.debug('snek getAssetMeta failed', { unit, err });
    }

    if (!ticker) {
      try {
        const stats = await this.dexhunter.getStatsByPolicyId(policyId);
        if (stats) {
          const stripped = (stats.unit ?? '').replace('.', '');
          const target = unit.replace('.', '');
          if (!stats.unit || stripped === target) {
            ticker = stats.ticker ?? stats.name ?? null;
            dhUnit = stats.unit ?? unit;
          }
        }
      } catch (err) {
        logger.debug('dexhunter getStatsByPolicyId failed', { unit, err });
      }
    }

    if (!ticker) {
      const decoded = hexToUtf8Safe(assetNameHex);
      if (decoded && /^[\x20-\x7e]+$/.test(decoded)) ticker = decoded;
    }

    if (!ticker) ticker = `NFT ${truncateMiddle(policyId, 6, 4)}`;

    const result = { ticker, logoCid, dhUnit, snekUnit };
    this.tickerCache.set(unit, { ...result, at: Date.now() });
    return result;
  }
}

function addAssets(into: Map<string, bigint>, from: Map<string, bigint>): void {
  for (const [unit, qty] of from) into.set(unit, (into.get(unit) ?? 0n) + qty);
}

function subtractAssets(into: Map<string, bigint>, from: Map<string, bigint>): void {
  for (const [unit, qty] of from) into.set(unit, (into.get(unit) ?? 0n) - qty);
}

function credFromStake(stakeBech32: string): string {
  const parsed = parseCardanoAddress(stakeBech32);
  if (!parsed || !parsed.stakeCredHex) {
    throw new Error(`credFromStake: not a stake address: ${stakeBech32}`);
  }
  return parsed.stakeCredHex;
}

