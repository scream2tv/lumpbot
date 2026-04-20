# Wallet Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Zing-style Cardano wallet watchlist to Lump Bot — users register addresses via `/watch` in one channel, a 60s background poller detects on-chain moves, and the bot DMs owners with a compact embed.

**Architecture:** New `walletWatchService` (pure logic: fetch txs, classify deltas, dispatch DMs) + `walletWatcher` (owns the `setInterval` poll loop). A `/watch` slash command with `add`/`remove`/`list` subcommands, channel-gated and rate-limited. Two new SQLite tables (`wallet_watches`, `wallet_rate_limit`). Blockfrost gains four helpers: `getStakeKeyForAddress`, `getAccountTransactions`, `getAccountAddresses`, `getTransactionUtxos`.

**Tech Stack:** TypeScript, discord.js 14, @blockfrost/blockfrost-js, axios, better-sqlite3, ts-node. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-19-wallet-watch-design.md`

**Testing note:** The repo has no test harness. Each task ends with `npm run lint` (which is `tsc --noEmit`). For pure logic (address validation, direction classification, storage) we write small throwaway verifier scripts under `scripts/` that use node's built-in `assert` and run via `ts-node`. Everything Blockfrost-facing or Discord-facing is covered by the manual smoke plan at the end.

---

## Task 1: Config additions

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Extend `LumpBotConfig` interface**

In `src/config.ts`, add these three fields to the `LumpBotConfig` interface (keep existing fields unchanged):

```typescript
  walletWatchChannelId: string;
  verifiedWalletRoleId: string;
  walletPollIntervalMs: number;
```

- [ ] **Step 2: Extend `loadConfig()`**

In the `loadConfig()` return object, add (alongside the other `required()` / `optional()` calls):

```typescript
    walletWatchChannelId: required('WALLET_WATCH_CHANNEL_ID'),
    verifiedWalletRoleId: required('VERIFIED_WALLET_ROLE_ID'),
    walletPollIntervalMs: Math.max(30000, Number(optional('WALLET_POLL_INTERVAL_MS', '60000')) || 60000),
```

The `Math.max(30000, …)` enforces the 30s floor stated in the spec.

- [ ] **Step 3: Add to `.env.example`**

Append to `.env.example`:

```
# Wallet watch feature
WALLET_WATCH_CHANNEL_ID=
VERIFIED_WALLET_ROLE_ID=
WALLET_POLL_INTERVAL_MS=60000
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example
git commit -m "Add wallet-watch env config (channel, role, poll interval)"
```

---

## Task 2: Cardano address utility (+ verifier script)

**Files:**
- Create: `src/utils/cardanoAddress.ts`
- Create: `scripts/verify-cardano-address.ts`

- [ ] **Step 1: Create `src/utils/cardanoAddress.ts`**

```typescript
export type CardanoNetwork = 'mainnet' | 'testnet';
export type AddressKind = 'payment' | 'stake';

export interface ParsedAddress {
  raw: string;
  kind: AddressKind;
  network: CardanoNetwork;
}

const BECH32_CHARSET = /^[ac-hj-np-z02-9]+$/;

/**
 * Minimal bech32 prefix + charset validation for Cardano addresses.
 * We do not verify the checksum — Blockfrost will reject junk on the
 * first API call during /watch add, which is a sufficient gate.
 */
export function parseCardanoAddress(input: string): ParsedAddress | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  const sepIdx = trimmed.lastIndexOf('1');
  if (sepIdx < 1) return null;

  const hrp = trimmed.slice(0, sepIdx);
  const data = trimmed.slice(sepIdx + 1);
  if (data.length < 6 || !BECH32_CHARSET.test(data)) return null;

  let kind: AddressKind;
  let network: CardanoNetwork;
  if (hrp === 'addr') { kind = 'payment'; network = 'mainnet'; }
  else if (hrp === 'addr_test') { kind = 'payment'; network = 'testnet'; }
  else if (hrp === 'stake') { kind = 'stake'; network = 'mainnet'; }
  else if (hrp === 'stake_test') { kind = 'stake'; network = 'testnet'; }
  else return null;

  return { raw: trimmed, kind, network };
}

export function shortenAddress(bech32: string): string {
  if (bech32.length <= 18) return bech32;
  return `${bech32.slice(0, 10)}…${bech32.slice(-6)}`;
}
```

- [ ] **Step 2: Create `scripts/verify-cardano-address.ts`**

```typescript
import assert from 'node:assert/strict';
import { parseCardanoAddress, shortenAddress } from '../src/utils/cardanoAddress';

const mp = parseCardanoAddress('addr1qy0abcdefghjklmnpqrstuvwxyz023456789abcdefghjklmnp');
assert.equal(mp?.kind, 'payment');
assert.equal(mp?.network, 'mainnet');

const ms = parseCardanoAddress('stake1u9abcdefghjklmnpqrstuvwxyz023456789abcdefghjklmnp');
assert.equal(ms?.kind, 'stake');
assert.equal(ms?.network, 'mainnet');

const tp = parseCardanoAddress('addr_test1qp0abcdefghjklmnpqrstuvwxyz023456');
assert.equal(tp?.kind, 'payment');
assert.equal(tp?.network, 'testnet');

assert.equal(parseCardanoAddress('xyz1abc'), null);
assert.equal(parseCardanoAddress('noseparator'), null);
assert.equal(parseCardanoAddress('addr1Babc'), null); // uppercase B not in bech32 charset
assert.equal(parseCardanoAddress(''), null);

assert.equal(shortenAddress('addr1qy0123456789longaddressstring987654zzz'), 'addr1qy012…54zzz');
assert.equal(shortenAddress('short'), 'short');

console.log('cardanoAddress OK');
```

- [ ] **Step 3: Run the verifier**

Run: `npx ts-node scripts/verify-cardano-address.ts`
Expected: prints `cardanoAddress OK` and exits 0.

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/cardanoAddress.ts scripts/verify-cardano-address.ts
git commit -m "Add cardanoAddress parser/shortener util with verifier"
```

---

## Task 3: Storage — `WalletWatch` types and migration

**Files:**
- Modify: `src/services/storage.ts`

- [ ] **Step 1: Add interfaces near the top of `storage.ts`**

Add after the existing `PolicyCall` interface (before `export class StorageService`):

```typescript
export interface WalletWatch {
  id: number;
  discordUserId: string;
  stakeKey: string;
  displayAddress: string;
  isEnterprise: boolean;
  label: string | null;
  createdAt: number;
  lastNotifiedTxHash: string | null;
  lastNotifiedAt: number | null;
  dmDisabledUntil: number | null;
}

export type WalletWatchAction = 'add' | 'remove';
```

- [ ] **Step 2: Extend `migrate()`**

Inside `StorageService.migrate()`, add these CREATE statements (after the existing tables, before the migrate method closes):

```typescript
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_watches (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id        TEXT NOT NULL,
        stake_key              TEXT NOT NULL,
        display_address        TEXT NOT NULL,
        is_enterprise          INTEGER NOT NULL DEFAULT 0,
        label                  TEXT,
        created_at             INTEGER NOT NULL,
        last_notified_tx_hash  TEXT,
        last_notified_at       INTEGER,
        dm_disabled_until      INTEGER,
        UNIQUE(discord_user_id, stake_key)
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_watches_stake ON wallet_watches(stake_key);
      CREATE INDEX IF NOT EXISTS idx_wallet_watches_user  ON wallet_watches(discord_user_id);

      CREATE TABLE IF NOT EXISTS wallet_rate_limit (
        discord_user_id  TEXT NOT NULL,
        action           TEXT NOT NULL,
        ts               INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_rate_limit_user_ts ON wallet_rate_limit(discord_user_id, ts);
    `);
```

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/storage.ts
git commit -m "Add wallet_watches and wallet_rate_limit schema"
```

---

## Task 4: Storage — watch CRUD methods

**Files:**
- Modify: `src/services/storage.ts`

- [ ] **Step 1: Add row mapper (inside `StorageService`, private method)**

Add inside the `StorageService` class:

```typescript
  private mapWalletWatchRow(row: any): WalletWatch {
    return {
      id: row.id,
      discordUserId: row.discord_user_id,
      stakeKey: row.stake_key,
      displayAddress: row.display_address,
      isEnterprise: Boolean(row.is_enterprise),
      label: row.label ?? null,
      createdAt: row.created_at,
      lastNotifiedTxHash: row.last_notified_tx_hash ?? null,
      lastNotifiedAt: row.last_notified_at ?? null,
      dmDisabledUntil: row.dm_disabled_until ?? null,
    };
  }
```

- [ ] **Step 2: Add core CRUD methods**

```typescript
  addWalletWatch(params: {
    userId: string;
    stakeKey: string;
    displayAddress: string;
    isEnterprise: boolean;
    baselineTxHash: string | null;
  }): WalletWatch {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO wallet_watches
         (discord_user_id, stake_key, display_address, is_enterprise,
          created_at, last_notified_tx_hash, last_notified_at, dm_disabled_until)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    );
    const info = stmt.run(
      params.userId,
      params.stakeKey,
      params.displayAddress,
      params.isEnterprise ? 1 : 0,
      now,
      params.baselineTxHash,
    );
    const row = this.db
      .prepare(`SELECT * FROM wallet_watches WHERE id = ?`)
      .get(info.lastInsertRowid);
    return this.mapWalletWatchRow(row);
  }

  removeWalletWatch(userId: string, stakeKeyOrDisplay: string): boolean {
    const stmt = this.db.prepare(
      `DELETE FROM wallet_watches
         WHERE discord_user_id = ?
           AND (stake_key = ? OR display_address = ?)`,
    );
    const info = stmt.run(userId, stakeKeyOrDisplay, stakeKeyOrDisplay);
    return info.changes > 0;
  }

  listWalletWatches(userId: string): WalletWatch[] {
    const rows = this.db
      .prepare(`SELECT * FROM wallet_watches WHERE discord_user_id = ? ORDER BY created_at ASC`)
      .all(userId);
    return rows.map((r) => this.mapWalletWatchRow(r));
  }

  countWalletWatches(userId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM wallet_watches WHERE discord_user_id = ?`)
      .get(userId) as { n: number };
    return row.n;
  }
```

Contract: `better-sqlite3` throws `SqliteError` with `code === 'SQLITE_CONSTRAINT_UNIQUE'` on UNIQUE violation. The `/watch add` handler (Task 11) catches this.

- [ ] **Step 3: Add poll-driver methods**

```typescript
  distinctWatchedStakeKeys(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT stake_key FROM wallet_watches`)
      .all() as Array<{ stake_key: string }>;
    return rows.map((r) => r.stake_key);
  }

  getWatchesForStakeKey(stakeKey: string): WalletWatch[] {
    const rows = this.db
      .prepare(`SELECT * FROM wallet_watches WHERE stake_key = ?`)
      .all(stakeKey);
    return rows.map((r) => this.mapWalletWatchRow(r));
  }

  updateWatchAfterNotify(id: number, txHash: string, ts: number): void {
    this.db
      .prepare(
        `UPDATE wallet_watches
           SET last_notified_tx_hash = ?, last_notified_at = ?
         WHERE id = ?`,
      )
      .run(txHash, ts, id);
  }

  setWatchDmCooldown(id: number, untilTs: number): void {
    this.db
      .prepare(`UPDATE wallet_watches SET dm_disabled_until = ? WHERE id = ?`)
      .run(untilTs, id);
  }
```

- [ ] **Step 4: Add rate-limit methods**

```typescript
  recordWatchAction(userId: string, action: WalletWatchAction): void {
    this.db
      .prepare(`INSERT INTO wallet_rate_limit (discord_user_id, action, ts) VALUES (?, ?, ?)`)
      .run(userId, action, Date.now());
  }

  countRecentWatchActions(userId: string, action: WalletWatchAction, windowMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM wallet_rate_limit
           WHERE discord_user_id = ? AND action = ? AND ts > ?`,
      )
      .get(userId, action, Date.now() - windowMs) as { n: number };
    return row.n;
  }

  cleanupWalletRateLimit(windowMs: number): void {
    this.db
      .prepare(`DELETE FROM wallet_rate_limit WHERE ts < ?`)
      .run(Date.now() - windowMs);
  }
```

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/storage.ts
git commit -m "Add storage methods for wallet watches and rate limit"
```

---

## Task 5: Storage verifier script

**Files:**
- Create: `scripts/verify-wallet-storage.ts`

- [ ] **Step 1: Create the verifier**

```typescript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StorageService } from '../src/services/storage';

const dbPath = path.join(__dirname, 'tmp-wallet-watch.sqlite');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const storage = new StorageService(dbPath);

const a = storage.addWalletWatch({
  userId: 'user1', stakeKey: 'stake1abc', displayAddress: 'addr1qxyz',
  isEnterprise: false, baselineTxHash: null,
});
assert.equal(a.discordUserId, 'user1');
assert.equal(a.stakeKey, 'stake1abc');

let threw = false;
try {
  storage.addWalletWatch({
    userId: 'user1', stakeKey: 'stake1abc', displayAddress: 'addr1qxyz',
    isEnterprise: false, baselineTxHash: null,
  });
} catch (err: any) {
  threw = true;
  assert.equal(err.code, 'SQLITE_CONSTRAINT_UNIQUE');
}
assert.equal(threw, true, 'expected UNIQUE violation');

storage.addWalletWatch({
  userId: 'user2', stakeKey: 'stake1abc', displayAddress: 'addr1qxyz',
  isEnterprise: false, baselineTxHash: null,
});

assert.equal(storage.countWalletWatches('user1'), 1);
assert.equal(storage.listWalletWatches('user2').length, 1);
assert.deepEqual(storage.distinctWatchedStakeKeys(), ['stake1abc']);
assert.equal(storage.getWatchesForStakeKey('stake1abc').length, 2);

storage.updateWatchAfterNotify(a.id, 'hash123', Date.now());
storage.setWatchDmCooldown(a.id, Date.now() + 3600_000);
const after = storage.listWalletWatches('user1')[0];
assert.equal(after.lastNotifiedTxHash, 'hash123');
assert.notEqual(after.dmDisabledUntil, null);

assert.equal(storage.removeWalletWatch('user1', 'stake1abc'), true);
assert.equal(storage.countWalletWatches('user1'), 0);
assert.equal(storage.removeWalletWatch('user1', 'stake1abc'), false);

storage.addWalletWatch({
  userId: 'user3', stakeKey: 'stake1def', displayAddress: 'addr1qdef',
  isEnterprise: false, baselineTxHash: null,
});
assert.equal(storage.removeWalletWatch('user3', 'addr1qdef'), true);

storage.recordWatchAction('user1', 'add');
storage.recordWatchAction('user1', 'add');
storage.recordWatchAction('user1', 'remove');
assert.equal(storage.countRecentWatchActions('user1', 'add', 60_000), 2);
assert.equal(storage.countRecentWatchActions('user1', 'remove', 60_000), 1);

storage.close();
fs.unlinkSync(dbPath);
console.log('wallet storage OK');
```

- [ ] **Step 2: Run the verifier**

Run: `npx ts-node scripts/verify-wallet-storage.ts`
Expected: prints `wallet storage OK`.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-wallet-storage.ts
git commit -m "Add wallet storage verifier script"
```

---

## Task 6: Blockfrost service additions

**Files:**
- Modify: `src/services/blockfrost.ts`

- [ ] **Step 1: Add types**

After the existing `PolicyAssetSummary` interface:

```typescript
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
```

- [ ] **Step 2: Add `getStakeKeyForAddress`**

Inside `BlockfrostService`:

```typescript
  /**
   * Returns the bech32 stake address for a payment address, or null if
   * the address is enterprise (no stake part) or unknown to Blockfrost.
   * Throws on network / server errors.
   */
  async getStakeKeyForAddress(addr: string): Promise<string | null> {
    try {
      const res: any = await this.rateLimiter.schedule(() => this.bf.addresses(addr));
      return res?.stake_address ?? null;
    } catch (err: any) {
      if (err?.status_code === 404) return null;
      throw err;
    }
  }
```

Note: the field on `@blockfrost/blockfrost-js` is `stake_address`.

- [ ] **Step 3: Add `getAccountTransactions`**

```typescript
  /**
   * Latest transactions for a stake account, newest first.
   * count caps at 100 per Blockfrost; we typically pass 10.
   */
  async getAccountTransactions(
    stakeAddress: string,
    opts: { count?: number } = {},
  ): Promise<AccountTransaction[]> {
    const count = Math.min(Math.max(opts.count ?? 10, 1), 100);
    const rows: any[] = await this.rateLimiter.schedule(() =>
      this.bf.accountsAddressesTransactions(stakeAddress, { count, order: 'desc' }),
    );
    return rows.map((r) => ({
      txHash: r.tx_hash,
      blockHeight: r.block_height,
      blockTime: r.block_time,
    }));
  }
```

- [ ] **Step 4: Add `getAccountAddresses`**

```typescript
  /**
   * All payment addresses registered under a stake key. Used for
   * membership tests when classifying tx direction.
   */
  async getAccountAddresses(stakeAddress: string): Promise<string[]> {
    const rows: any[] = await this.rateLimiter.schedule(() =>
      this.bf.accountsAddresses(stakeAddress, { count: 100 }),
    );
    return rows.map((r) => r.address);
  }
```

- [ ] **Step 5: Add `getTransactionUtxos`**

```typescript
  async getTransactionUtxos(txHash: string): Promise<TxUtxos> {
    const res: any = await this.rateLimiter.schedule(() => this.bf.txsUtxos(txHash));
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
```

If the private rate-limiter field isn't named `rateLimiter` in the current file, substitute the correct name consistently in all four methods. (Check by reading the existing `fetchFromBlockfrost` implementation for the field reference.)

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/services/blockfrost.ts
git commit -m "Add Blockfrost helpers for account txs, utxos, and stake resolution"
```

---

## Task 7: `walletWatchService` skeleton + pure classification

**Files:**
- Create: `src/services/walletWatchService.ts`
- Create: `src/utils/walletDmEmbed.ts` (stub)
- Create: `scripts/verify-wallet-classify.ts`

- [ ] **Step 1: Create a minimal `walletDmEmbed.ts` stub (Task 8 fills it out)**

```typescript
import { EmbedBuilder } from 'discord.js';

export interface WalletAssetDelta {
  unit: string;
  quantity: bigint;
  label?: string;
}

export interface WalletMoveEvent {
  displayAddress: string;
  direction: 'IN' | 'OUT' | 'SELF';
  lovelaceDelta: bigint;
  assetDeltas: WalletAssetDelta[];
  txHash: string;
  blockTime: number;
  cardanoscanBase: string;
}

export function buildWalletMoveEmbed(evt: WalletMoveEvent): EmbedBuilder {
  return new EmbedBuilder().setTitle(`Wallet moved — ${evt.displayAddress}`);
}

export function buildWalletMovePlaintext(evt: WalletMoveEvent): string {
  return `Wallet ${evt.displayAddress} moved: ${evt.cardanoscanBase}/transaction/${evt.txHash}`;
}

export function buildBurstSummaryEmbed(
  displayAddress: string,
  count: number,
  latestTxHash: string,
  cardanoscanBase: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${count} moves — ${displayAddress}`)
    .setDescription(`Latest: ${cardanoscanBase}/transaction/${latestTxHash}`);
}
```

- [ ] **Step 2: Create `src/services/walletWatchService.ts`**

```typescript
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
```

- [ ] **Step 3: Create classification verifier `scripts/verify-wallet-classify.ts`**

```typescript
import assert from 'node:assert/strict';
import { classifyTx } from '../src/services/walletWatchService';

const mine = new Set(['addr1qmine']);

const out = classifyTx({
  hash: 'h1',
  inputs: [{ address: 'addr1qmine', amount: [{ unit: 'lovelace', quantity: '5000000' }] }],
  outputs: [{ address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '4500000' }] }],
}, mine);
assert.equal(out.direction, 'OUT');
assert.equal(out.lovelaceDelta, -5000000n);

const inc = classifyTx({
  hash: 'h2',
  inputs: [{ address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '3000000' }] }],
  outputs: [{ address: 'addr1qmine',  amount: [{ unit: 'lovelace', quantity: '3000000' }] }],
}, mine);
assert.equal(inc.direction, 'IN');
assert.equal(inc.lovelaceDelta, 3000000n);

const self = classifyTx({
  hash: 'h3',
  inputs: [{ address: 'addr1qmine', amount: [{ unit: 'lovelace', quantity: '10000000' }] }],
  outputs: [
    { address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '4000000' }] },
    { address: 'addr1qmine',  amount: [{ unit: 'lovelace', quantity: '5800000' }] },
  ],
}, mine);
assert.equal(self.direction, 'SELF');
assert.equal(self.lovelaceDelta, -4200000n);

const tok = classifyTx({
  hash: 'h4',
  inputs: [{ address: 'addr1qother', amount: [{ unit: 'lovelace', quantity: '2000000' }] }],
  outputs: [{
    address: 'addr1qmine',
    amount: [
      { unit: 'lovelace', quantity: '2000000' },
      { unit: 'abc123.534e454b', quantity: '1000000' },
    ],
  }],
}, mine);
assert.equal(tok.direction, 'IN');
assert.equal(tok.assetDeltas.length, 1);
assert.equal(tok.assetDeltas[0].unit, 'abc123.534e454b');
assert.equal(tok.assetDeltas[0].quantity, 1000000n);

console.log('classifyTx OK');
```

- [ ] **Step 4: Run verifier + typecheck**

Run: `npx ts-node scripts/verify-wallet-classify.ts`
Expected: `classifyTx OK`.

Run: `npm run lint`
Expected: no errors. If TypeScript complains about unused imports (`DiscordAPIError`, `buildWalletMoveEmbed`, etc.), leave them — Task 9 uses them.

- [ ] **Step 5: Commit**

```bash
git add src/services/walletWatchService.ts src/utils/walletDmEmbed.ts scripts/verify-wallet-classify.ts
git commit -m "Add wallet watch service skeleton with classifyTx + verifier"
```

---

## Task 8: Full DM embed builder

**Files:**
- Modify: `src/utils/walletDmEmbed.ts`

- [ ] **Step 1: Replace the stub with the full embed**

```typescript
import { EmbedBuilder } from 'discord.js';
import { formatAda, formatNumber, truncateMiddle, hexToUtf8Safe } from './formatters';
import { shortenAddress } from './cardanoAddress';

export interface WalletAssetDelta {
  unit: string;
  quantity: bigint;
  label?: string;
}

export interface WalletMoveEvent {
  displayAddress: string;
  direction: 'IN' | 'OUT' | 'SELF';
  lovelaceDelta: bigint;
  assetDeltas: WalletAssetDelta[];
  txHash: string;
  blockTime: number;       // unix seconds
  cardanoscanBase: string; // https://cardanoscan.io or https://preprod.cardanoscan.io
}

const DIRECTION_LABEL = {
  IN:   '⬅️ IN',
  OUT:  '➡️ OUT',
  SELF: '🔁 SELF',
} as const;

function formatSignedAda(lovelace: bigint): string {
  const negative = lovelace < 0n;
  const abs = negative ? -lovelace : lovelace;
  const ada = Number(abs) / 1_000_000;
  const sign = negative ? '−' : lovelace === 0n ? '' : '+';
  return `${sign}${formatAda(ada, 2)} ADA`;
}

function assetLabel(d: WalletAssetDelta): string {
  if (d.label) return d.label;
  const dot = d.unit.indexOf('.');
  if (dot < 0) return d.unit;
  const assetNameHex = d.unit.slice(dot + 1);
  const decoded = hexToUtf8Safe(assetNameHex);
  if (decoded && /^[\x20-\x7e]+$/.test(decoded)) return decoded;
  return `NFT ${truncateMiddle(d.unit.slice(0, dot), 6, 4)}`;
}

function formatAssetLine(d: WalletAssetDelta): string {
  const neg = d.quantity < 0n;
  const abs = neg ? -d.quantity : d.quantity;
  const sign = neg ? '−' : '+';
  return `${sign} ${formatNumber(Number(abs), 0)} ${assetLabel(d)}`;
}

export function buildWalletMoveEmbed(evt: WalletMoveEvent): EmbedBuilder {
  const short = shortenAddress(evt.displayAddress);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💸 Wallet moved — ${short}`)
    .addFields(
      { name: 'Direction', value: DIRECTION_LABEL[evt.direction], inline: true },
      { name: 'Net ADA',   value: formatSignedAda(evt.lovelaceDelta), inline: true },
    );

  if (evt.assetDeltas.length > 0) {
    const shown = evt.assetDeltas.slice(0, 3).map(formatAssetLine);
    const more = evt.assetDeltas.length - shown.length;
    const value = shown.join('\n') + (more > 0 ? `\n… and ${more} more` : '');
    embed.addFields({ name: 'Assets', value });
  }

  embed.addFields({
    name: 'Tx',
    value: `[cardanoscan](${evt.cardanoscanBase}/transaction/${evt.txHash})`,
  });

  if (evt.blockTime > 0) {
    embed.setTimestamp(new Date(evt.blockTime * 1000));
  }
  return embed;
}

export function buildWalletMovePlaintext(evt: WalletMoveEvent): string {
  const short = shortenAddress(evt.displayAddress);
  return `💸 Wallet ${short} moved: ${evt.cardanoscanBase}/transaction/${evt.txHash}`;
}

export function buildBurstSummaryEmbed(
  displayAddress: string,
  count: number,
  latestTxHash: string,
  cardanoscanBase: string,
): EmbedBuilder {
  const short = shortenAddress(displayAddress);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💸 ${count} moves — ${short}`)
    .setDescription(`Latest: [cardanoscan](${cardanoscanBase}/transaction/${latestTxHash})`);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/walletDmEmbed.ts
git commit -m "Implement wallet move DM embed with plaintext fallback and burst summary"
```

---

## Task 9: `walletWatchService.checkWallet` + DM dispatch

**Files:**
- Modify: `src/services/walletWatchService.ts`

- [ ] **Step 1: Add `getMineAddresses` with TTL cache**

Inside `WalletWatchService` (after `baselineTxHashFor`):

```typescript
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
```

- [ ] **Step 2: Add `checkWallet` and private DM helpers**

```typescript
  async checkWallet(stakeKey: string): Promise<void> {
    const subs = this.storage.getWatchesForStakeKey(stakeKey);
    if (subs.length === 0) return;

    let txs;
    try {
      txs = await this.blockfrost.getAccountTransactions(stakeKey, { count: 10 });
    } catch (err) {
      logger.warn({ stakeKey, err }, 'getAccountTransactions failed');
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
          logger.info(
            { userId: sub.discordUserId, stakeKey },
            'DMs blocked, cooling down 24h',
          );
          this.storage.setWatchDmCooldown(sub.id, Date.now() + DM_COOLDOWN_MS);
        } else {
          logger.warn({ subId: sub.id, err }, 'DM dispatch failed');
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
```

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/walletWatchService.ts
git commit -m "Implement WalletWatchService.checkWallet and DM dispatch"
```

---

## Task 10: `walletWatcher` background loop

**Files:**
- Create: `src/services/walletWatcher.ts`

- [ ] **Step 1: Create the watcher**

```typescript
import { StorageService } from './storage';
import { WalletWatchService } from './walletWatchService';
import { logger } from '../utils/logger';

export class WalletWatcher {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly storage: StorageService,
    private readonly svc: WalletWatchService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: this.intervalMs }, 'WalletWatcher started');
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const stakeKeys = this.storage.distinctWatchedStakeKeys();
      for (const stakeKey of stakeKeys) {
        try {
          await this.svc.checkWallet(stakeKey);
        } catch (err) {
          logger.warn({ stakeKey, err }, 'wallet poll failed, continuing');
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
```

Concurrency is already bounded by the `RateLimiter` inside `BlockfrostService` — no outer throttle needed here.

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/walletWatcher.ts
git commit -m "Add WalletWatcher background polling loop"
```

---

## Task 11: `/watch` slash command

**Files:**
- Create: `src/commands/watch.ts`

- [ ] **Step 1: Create the command module**

Pattern-match on `src/commands/verify.ts` for the builder-and-handler style. Full file:

```typescript
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildMember,
} from 'discord.js';
import { SlashCommand } from './types';
import { BotContext } from '../botContext';
import { parseCardanoAddress, shortenAddress } from '../utils/cardanoAddress';
import { logger } from '../utils/logger';

const data = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Watch a Cardano wallet and get DM alerts when it moves')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a wallet address to your watch list')
      .addStringOption((o) =>
        o.setName('address').setDescription('addr1… or stake1…').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a wallet address from your watch list')
      .addStringOption((o) =>
        o.setName('address').setDescription('addr1… or stake1…').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show your watched wallets'),
  );

async function run(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  if (interaction.channelId !== ctx.config.walletWatchChannelId) {
    await interaction.reply({
      content: `This command only works in <#${ctx.config.walletWatchChannelId}>.`,
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand(true);
  if (sub === 'add') return handleAdd(interaction, ctx);
  if (sub === 'remove') return handleRemove(interaction, ctx);
  if (sub === 'list') return handleList(interaction, ctx);
}

async function handleAdd(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const userId = interaction.user.id;
  if (ctx.storage.countRecentWatchActions(userId, 'add', 60_000) >= 10) {
    await interaction.reply({ content: 'Slow down — try again in a minute.', ephemeral: true });
    return;
  }
  ctx.storage.recordWatchAction(userId, 'add');

  const raw = interaction.options.getString('address', true);
  const parsed = parseCardanoAddress(raw);
  if (!parsed) {
    await interaction.reply({
      content: "That doesn't look like a valid Cardano address.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member as GuildMember | null;
  const hasVerifiedRole =
    member?.roles?.cache?.has(ctx.config.verifiedWalletRoleId) ?? false;
  const limit = hasVerifiedRole ? 20 : 6;
  if (ctx.storage.countWalletWatches(userId) >= limit) {
    await interaction.reply({
      content:
        `You're at the ${limit}-wallet limit ` +
        `(${hasVerifiedRole ? 'verified' : 'unverified'}). Remove one with /watch remove first.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let stakeKey: string;
  let isEnterprise = false;
  let enterpriseNote = '';
  let baselineTxHash: string | null = null;
  let neverActive = false;

  try {
    if (parsed.kind === 'stake') {
      stakeKey = parsed.raw;
    } else {
      const resolved = await ctx.blockfrost.getStakeKeyForAddress(parsed.raw);
      if (resolved) {
        stakeKey = resolved;
      } else {
        stakeKey = parsed.raw;
        isEnterprise = true;
        enterpriseNote =
          "\n⚠️ This is an enterprise address (no stake key). " +
          "I'll watch only this specific address — funds moved to other addresses won't be detected.";
      }
    }

    try {
      baselineTxHash = await ctx.walletWatchService.baselineTxHashFor(stakeKey);
    } catch (err: any) {
      if (err?.status_code === 404) {
        neverActive = true;
      } else {
        throw err;
      }
    }
  } catch (err) {
    logger.warn({ err, raw }, '/watch add: blockfrost lookup failed');
    await interaction.editReply(
      "Couldn't verify that address right now — try again in a moment.",
    );
    return;
  }

  try {
    ctx.storage.addWalletWatch({
      userId,
      stakeKey,
      displayAddress: parsed.raw,
      isEnterprise,
      baselineTxHash,
    });
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      await interaction.editReply("You're already watching that wallet.");
      return;
    }
    logger.error({ err }, '/watch add: insert failed');
    await interaction.editReply('Something went wrong saving that. Try again.');
    return;
  }

  const neverActiveNote = neverActive
    ? "\nℹ️ This address has no on-chain activity yet. I'll DM you when it does."
    : '';

  await interaction.editReply(
    `✅ Watching ${shortenAddress(parsed.raw)}. You'll get a DM in this account when it moves.` +
      `${enterpriseNote}${neverActiveNote}`,
  );
}

async function handleRemove(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const userId = interaction.user.id;
  if (ctx.storage.countRecentWatchActions(userId, 'remove', 60_000) >= 10) {
    await interaction.reply({ content: 'Slow down — try again in a minute.', ephemeral: true });
    return;
  }
  ctx.storage.recordWatchAction(userId, 'remove');

  const raw = interaction.options.getString('address', true).trim().toLowerCase();
  let removed = ctx.storage.removeWalletWatch(userId, raw);
  if (!removed) {
    const parsed = parseCardanoAddress(raw);
    if (parsed && parsed.kind === 'payment') {
      try {
        const stakeKey = await ctx.blockfrost.getStakeKeyForAddress(parsed.raw);
        if (stakeKey) removed = ctx.storage.removeWalletWatch(userId, stakeKey);
      } catch {
        // best-effort
      }
    }
  }

  await interaction.reply({
    content: removed ? '🗑️ Removed.' : "You weren't watching that wallet.",
    ephemeral: true,
  });
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const userId = interaction.user.id;
  const member = interaction.member as GuildMember | null;
  const hasVerifiedRole =
    member?.roles?.cache?.has(ctx.config.verifiedWalletRoleId) ?? false;
  const cap = hasVerifiedRole ? 20 : 6;

  const rows = ctx.storage.listWalletWatches(userId);
  if (rows.length === 0) {
    await interaction.reply({
      content: "You're not watching any wallets yet. Use /watch add <address>.",
      ephemeral: true,
    });
    return;
  }

  const lines = rows.map((r) => {
    const ago = Math.max(1, Math.round((Date.now() - r.createdAt) / 60_000));
    const when =
      ago < 60 ? `${ago}m ago` :
      ago < 60 * 24 ? `${Math.round(ago / 60)}h ago` :
      `${Math.round(ago / (60 * 24))}d ago`;
    return `• ${shortenAddress(r.displayAddress)} — added ${when}`;
  });
  const header = `You're watching ${rows.length}/${cap} wallets.`;
  await interaction.reply({ content: `${header}\n${lines.join('\n')}`, ephemeral: true });
}

const watchCommand: SlashCommand = { data, execute: run };
export default watchCommand;
```

Note: the final assignment uses `{ data, execute: run }` to match the existing `SlashCommand` interface's `execute` field name without ever shadowing that name inside this file. Verify the existing `SlashCommand` interface actually names it `execute` — if it uses a different field name, substitute accordingly in the export literal.

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: errors about `ctx.walletWatchService` not existing are fine — Task 12 resolves them. If there are unrelated errors, fix them before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/commands/watch.ts
git commit -m "Add /watch add/remove/list slash command"
```

---

## Task 12: Wire services into `BotContext` and startup

**Files:**
- Modify: `src/botContext.ts`
- Modify: `src/commands/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Extend `BotContext`**

In `src/botContext.ts`, add imports:

```typescript
import { WalletWatchService } from './services/walletWatchService';
import { WalletWatcher } from './services/walletWatcher';
```

Add to the `BotContext` interface:

```typescript
  walletWatchService: WalletWatchService;
  walletWatcher: WalletWatcher;
```

- [ ] **Step 2: Register the command**

In `src/commands/index.ts`:

```typescript
import watch from './watch';
```

Inside `buildCommandCollection()`, add alongside the existing `collection.set(...)` calls:

```typescript
  collection.set(watch.data.name, watch);
```

- [ ] **Step 3: Wire `src/index.ts`**

Imports:

```typescript
import { WalletWatchService } from './services/walletWatchService';
import { WalletWatcher } from './services/walletWatcher';
```

Inside `main()`, after the Discord `client` is constructed and after the existing services (`AlertService`, etc.) are built, add:

```typescript
  const cardanoscanBase = config.blockfrostApiKey?.includes('preprod')
    ? 'https://preprod.cardanoscan.io'
    : 'https://cardanoscan.io';

  const walletWatchService = new WalletWatchService(
    storage,
    blockfrost,
    dexhunter,
    client,
    cardanoscanBase,
  );
  const walletWatcher = new WalletWatcher(
    storage,
    walletWatchService,
    config.walletPollIntervalMs,
  );
```

Add both fields to the `BotContext` literal that gets passed to `registerEvents(...)`:

```typescript
    walletWatchService,
    walletWatcher,
```

In the `ready` handler (wherever the existing hourly cleanup `setInterval` is created), add:

```typescript
  walletWatcher.start();
```

In the `shutdown` function, before `client.destroy()`:

```typescript
  walletWatcher.stop();
```

Inside the existing hourly cleanup callback (the one that calls `storage.cleanupExpiredAlerts(...)`), add:

```typescript
    storage.cleanupWalletRateLimit(60 * 60 * 1000);
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/botContext.ts src/commands/index.ts src/index.ts
git commit -m "Wire WalletWatchService and WalletWatcher into startup"
```

---

## Task 13: Deploy slash command and update docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Deploy the command to Discord**

Run: `npm run deploy`
Expected: logs show `/watch` registered alongside existing commands.

If the deploy script builds its command list from something other than `buildCommandCollection()`, inspect `src/deploy-commands.ts` and add the new entry.

- [ ] **Step 2: Update README**

Add a new section (after the existing commands docs):

```markdown
## Wallet watch

Users can register Cardano wallet addresses in a designated channel and receive DMs when the wallet has on-chain activity.

- `WALLET_WATCH_CHANNEL_ID` — the only channel where `/watch` works.
- `VERIFIED_WALLET_ROLE_ID` — role that raises the per-user cap from 6 to 20 wallets.
- `WALLET_POLL_INTERVAL_MS` — optional, how often to poll Blockfrost (default 60000, min 30000).

Commands (all ephemeral, only work in the configured channel):
- `/watch add <addr1…|stake1…>` — start watching. Payment addresses are normalized to the stake key so moves across all addresses in the wallet are detected. Enterprise addresses are watched as-is with a warning.
- `/watch remove <addr1…|stake1…>` — stop watching.
- `/watch list` — show your own watchlist (never anyone else's).

DMs must be enabled for the bot. If a DM fails, that subscription is cooled down for 24 hours.

No additional Discord intents are required. Sending DMs via `user.send()` works with the existing intent set.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document /watch wallet watch feature"
```

---

## Task 14: Manual smoke verification

No code changes. Work through each step live against a dev guild; fix any mismatch before calling the feature done.

- [ ] **Step 1: Start the bot** — `npm run dev`. Confirm log `WalletWatcher started`.
- [ ] **Step 2: Channel gate** — `/watch add <any>` outside the watch channel → ephemeral rejection with the channel mention.
- [ ] **Step 3: Valid add** — `/watch add <your addr1…>` in the channel → `✅ Watching …`. SQLite row has `stake_key` starting with `stake1…`.
- [ ] **Step 4: Enterprise address** — add one → warning note in reply.
- [ ] **Step 5: Duplicate** — re-add same → `You're already watching that wallet.`
- [ ] **Step 6: Unverified cap** — without the role, fill to 6, add a 7th → cap message.
- [ ] **Step 7: Verified cap** — grant the role, fill to 20, add 21st → cap message with `(verified)`.
- [ ] **Step 8: OUT** — send ADA from a watched wallet → DM with `➡️ OUT`, negative ADA, Cardanoscan link.
- [ ] **Step 9: IN** — receive ADA → DM with `⬅️ IN`.
- [ ] **Step 10: SELF** — send between addresses under the same stake key → DM with `🔁 SELF` (delta ≈ fee only).
- [ ] **Step 11: DM blocked** — block bot DMs, trigger a move → log shows `DMs blocked, cooling down 24h`, `dm_disabled_until` set; no crash.
- [ ] **Step 12: list** — `/watch list` shows only your own rows with header `You're watching N/cap wallets.`
- [ ] **Step 13: remove** — removal works by pasted payment address and by stake key.
- [ ] **Step 14: rate limit** — rapid `/watch add` 11 times → 11th gets `Slow down — try again in a minute.`
- [ ] **Step 15: commit any fixes** — if something broke, fix it and commit. Otherwise, done.

---

## Self-review summary

Against `docs/superpowers/specs/2026-04-19-wallet-watch-design.md`:

- Config (channel, role, interval): Task 1. ✅
- Data model (tables, indexes, methods): Tasks 3 + 4 + 5 verifier. ✅
- Move definition + three anti-spam layers (hash dedupe, 30s cooldown, burst collapse): Task 9 (`checkWallet`). ✅
- Address normalization (payment/stake/enterprise, network match): Task 11 `handleAdd`. ✅
- Slash command (add/remove/list, channel gate, rate gate, cap, ephemeral, privacy): Task 11. ✅
- Background watcher with `try/finally` guard: Task 10. ✅
- Direction classification via cached account addresses with 1h TTL: Tasks 6, 7, 9. ✅
- DM embed + plaintext fallback + burst summary: Task 8. ✅
- Wiring / intents note: Task 12 + Task 13. ✅
- README: Task 13. ✅
- Manual smoke matching the spec's testing plan: Task 14. ✅

