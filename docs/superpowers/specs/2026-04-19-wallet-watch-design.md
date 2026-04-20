# Wallet Watch — Design Spec

**Date:** 2026-04-19
**Status:** Approved for implementation planning
**Feature:** Zing-style Cardano wallet watchlist for Lump Bot (Discord)

## Summary

Users register Cardano wallet addresses in one designated Discord channel via slash commands. A background poller checks each watched wallet for new on-chain activity and DMs the owning user with a compact embed describing the move. Wallets are normalized to stake keys so one "wallet" tracks all payment addresses under the same stake account.

## Configuration

Add to `config.ts` (via `loadConfig()`), all loaded from env:

- `WALLET_WATCH_CHANNEL_ID` — required. The only channel where `/watch` commands are accepted.
- `VERIFIED_WALLET_ROLE_ID` — required. Role that raises the per-user cap from 6 to 20.
- `WALLET_POLL_INTERVAL_MS` — optional, default `60000`, min `30000`. Interval between poll ticks.

Secrets/IDs from the user's request (to be set in `.env`, documented in `.env.example` and README):

- `WALLET_WATCH_CHANNEL_ID=1495610888856539226`
- `VERIFIED_WALLET_ROLE_ID=1495117724794355882`

Discord intents: no additions required. The existing `Guilds`, `GuildMessages`, `MessageContent` intents plus `Partials.Channel` are sufficient to send DMs via `user.send()`. (`DirectMessages` intent is only needed for *receiving* DMs — not this feature.) Documented in README.

## Architecture

Follows the existing `BotContext` DI pattern. New services instantiate at startup and are passed through context to handlers.

### New files

- `src/services/walletWatchService.ts` — business logic: fetch new txs for a stake key, classify direction and deltas, dispatch DMs. No Discord intents or polling concerns leak in.
- `src/services/walletWatcher.ts` — background poller owning the `setInterval` loop. Calls `walletWatchService.checkWallet(stakeKey)` for each distinct watched stake key per tick.
- `src/commands/watch.ts` — slash command with `add`, `remove`, `list` subcommands.
- `src/utils/cardanoAddress.ts` — bech32 validation and address-kind detection (payment vs stake, mainnet vs testnet), plus display-shortening helper.
- `src/utils/walletDmEmbed.ts` — builds the compact DM embed.

### Modified files

- `src/services/storage.ts` — two new tables (`wallet_watches`, `wallet_rate_limit`) plus methods.
- `src/services/blockfrost.ts` — add `getStakeKeyForAddress(addr)`, `getAccountTransactions(stake, { after?, count? })`, `getTransactionUtxos(hash)`. Reuses the existing `BlockFrostAPI` client.
- `src/config.ts` — three new config fields (above).
- `src/botContext.ts` — expose `walletWatchService` and `walletWatcher`.
- `src/index.ts` — instantiate new services, start the watcher interval, clear it in the SIGINT/SIGTERM shutdown handler alongside the existing 1h cleanup interval.
- `src/commands/index.ts` — register the new `watch` command.
- `src/deploy-commands.ts` — picks it up automatically if it reads from the commands collection (verify during implementation).

## Data model (SQLite, in `StorageService.migrate()`)

```sql
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
```

**Dedupe model:** `last_notified_tx_hash` is per `(user, wallet)` subscription, not per wallet. Two users watching the same wallet each advance their own cursor and each receive their own DM.

**Privacy invariant:** `listWalletWatches()` always filters by `discord_user_id = invoker`. No admin/all-users query exists in v1.

### New `StorageService` methods

- `addWalletWatch({ userId, stakeKey, displayAddress, isEnterprise, baselineTxHash })` → `WalletWatch` — throws on UNIQUE violation (duplicate).
- `removeWalletWatch(userId, stakeKeyOrDisplay)` → `boolean` — matches on either the stake key or the original pasted address.
- `listWalletWatches(userId)` → `WalletWatch[]`.
- `countWalletWatches(userId)` → `number` (for cap enforcement).
- `distinctWatchedStakeKeys()` → `string[]` (driver for the poll loop).
- `getWatchesForStakeKey(stakeKey)` → `WalletWatch[]` (fanout targets).
- `updateWatchAfterNotify(id, txHash, ts)`.
- `setWatchDmCooldown(id, untilTs)`.
- `recordWatchAction(userId, action)`, `countRecentWatchActions(userId, action, windowMs)`.
- `cleanupWalletRateLimit(windowMs)` — called from the existing hourly cleanup tick.

## Move definition

A "move" is **any new transaction touching the watched stake key** — sender, receiver, or both. Full activity feed: transfers, swaps, native tokens, NFTs, reward withdrawals, delegation changes.

**Anti-spam (three layers):**

1. **Hash dedupe** — per subscription, we never DM the same `tx_hash` twice. On `/watch add` we record the current tip tx hash as baseline so existing history is never backfilled.
2. **Per-wallet cooldown** — skip if `now < sub.last_notified_at + 30_000` (30s).
3. **Burst collapse** — if a tick produces >3 new txs for a subscription, send one summary DM (`💸 N moves in <wallet>. Latest: <link>`) instead of N individual DMs.

## Address normalization

Accepted bech32 prefixes: `addr1`, `addr_test1`, `stake1`, `stake_test1`. Network is inferred from the configured Blockfrost key; mismatches are rejected with a clear error.

- **`stake1…` / `stake_test1…`** → `stake_key = input`, `is_enterprise = 0`.
- **`addr1…` with stake part** → call `getStakeKeyForAddress()` (Blockfrost `/addresses/{addr}` returns `stake_address`). `stake_key` = that bech32.
- **`addr1…` enterprise (no stake)** → `stake_key = display_address`, `is_enterprise = 1`. The add reply includes: `⚠️ This is an enterprise address (no stake key). I'll watch only this specific address — funds moved to other addresses won't be detected.`

## Slash command behavior (`/watch`)

All replies are ephemeral. Every invocation first checks `interaction.channelId === walletWatchChannelId`; if not, reply `This command only works in <#CHANNEL_ID>.` and return.

### `/watch add <address>`

1. Channel gate.
2. Per-user rate gate (`action='add'`): `countRecentWatchActions(user, 'add', 60_000) >= 10` → reply `Slow down — try again in a minute.` Otherwise `recordWatchAction(user, 'add')`.
3. Validate via `cardanoAddress.ts` (bech32 + network match). Invalid → `That doesn't look like a valid Cardano address.`
4. Normalize to stake key (see above).
5. Enforce cap: `limit = member.roles.cache.has(verifiedWalletRoleId) ? 20 : 6`. At limit → reply with the count and limit.
6. Fetch baseline: `getAccountTransactions(stake_key, { count: 1, order: 'desc' })[0]?.tx_hash` (nullable).
7. `addWalletWatch(...)`. UNIQUE violation → `You're already watching that wallet.`
8. Success reply: `✅ Watching <short addr>. You'll get a DM in this account when it moves.` (Plus enterprise note if applicable.)

**Blockfrost error during steps 4 or 6** → `Couldn't verify that address right now — try again in a moment.` No DB write.
**Blockfrost 404 on `/addresses/{addr}`** (never transacted) → allow add with `baselineTxHash = null`; note: `This address has no on-chain activity yet. I'll DM you when it does.`

### `/watch remove <address>`

1. Channel gate + rate gate (`action='remove'`).
2. `removeWalletWatch(user, address)` tries both as-stake-key and re-normalized.
3. Reply `🗑️ Removed.` or `You weren't watching that wallet.` (Never leaks whether anyone else is watching.)

### `/watch list`

1. Channel gate.
2. `listWalletWatches(user)` — invoker only.
3. Reply ephemerally with a header `You're watching N/${cap} wallets.` and one line per watch: `• <short addr> — added <relative time>`. Empty: `You're not watching any wallets yet. Use /watch add <address>.`

**Address shortening helper:** `bech32[0..8] + "…" + bech32[-6..]`, used in add/list replies and DM titles.

## Background watcher

`walletWatcher.ts` loop (mirrors the existing cleanup-interval pattern in `index.ts`):

```
every WALLET_POLL_INTERVAL_MS:
  if isTicking: return   // skip if previous tick still running
  isTicking = true
  try {
    stakeKeys = storage.distinctWatchedStakeKeys()
    for each stakeKey:
      await blockfrostRateLimiter.acquire()   // existing RateLimiter (token bucket)
      try { await walletWatchService.checkWallet(stakeKey) }
      catch err { logger.warn({ stakeKey, err }, 'wallet poll failed, continuing') }
  } finally {
    isTicking = false
  }
```

The rate limiter is the existing `src/utils/rateLimiter.ts` used by other Blockfrost-facing services; the watcher shares the same bucket so combined traffic stays under the account quota.

### `walletWatchService.checkWallet(stakeKey)`

1. `subs = storage.getWatchesForStakeKey(stakeKey)`. If empty, return.
2. Fetch the latest 10 txs for the stake key (Blockfrost, newest-first).
3. For each subscription:
   - Slice the tx list to entries newer than `sub.last_notified_tx_hash` (or all if null).
   - Skip if `now < sub.last_notified_at + 30_000`.
   - Skip if `now < sub.dm_disabled_until`.
   - If new-tx count > 3, send one summary DM; else one DM per tx.
   - For each individual DM: fetch `/txs/{hash}/utxos`, classify direction and deltas (see below), build embed, DM it.

**Direction classification:** Blockfrost UTxO addresses are full bech32 strings that include the stake component, but parsing them without a heavy library is brittle. Instead, on the first DM for a stake key (or after a 1h TTL), cache its payment-address set via `GET /accounts/{stake}/addresses` and store in memory on the service. For each tx:

- `mine = Set` of the cached payment addresses (or `{displayAddress}` for enterprise).
- `inputsMine = any(input.address ∈ mine)`, `outputsMine = any(output.address ∈ mine)`.
- If `inputsMine && outputsMine` → `SELF` (change output still lands in `mine`).
- If `inputsMine && !outputsMine` → `OUT`.
- If `!inputsMine && outputsMine` → `IN`.

**ADA delta:** `sum(output.amount.lovelace for output.address ∈ mine) − sum(input.amount.lovelace for input.address ∈ mine)`.

**Native-asset deltas:** same sum by `unit` (policyId+assetName hex), sorted by `|abs|` descending, top 3 kept. Tickers resolved via DexHunter if available; otherwise hex asset name decoded via existing `hexToUtf8Safe`; NFTs (quantity=1 and large token) display as `NFT <shortPolicy>`.
4. On successful send: `updateWatchAfterNotify(sub.id, newestHashInBatch, now)`.
5. On DM failure (Discord error, e.g. 50007): log once at info, `setWatchDmCooldown(sub.id, now + 24*3600*1000)`, do NOT advance the cursor. When DMs come back, the user naturally receives the backlog (bounded by the 10-tx fetch window — larger gaps collapse to a summary).

### DM embed (`walletDmEmbed.ts`)

- Color: `0x5865F2` (neutral).
- Title: `💸 Wallet moved — <short addr>`.
- Fields:
  - `Direction`: `➡️ OUT` / `⬅️ IN` / `🔁 SELF`.
  - `Net ADA`: signed, via existing `formatters.lovelaceToAda`.
  - `Assets`: up to 3 lines (`+ 1,000,000 SNEK`, `− 1 NFT <short policy>`), `… and N more` if truncated. Ticker resolved via DexHunter where available; asset name hex decoded via existing `hexToUtf8Safe`.
  - `Tx`: `[cardanoscan](https://cardanoscan.io/transaction/<hash>)` (or `preprod.cardanoscan.io` on testnet).
- Footer: relative timestamp of the tx block.

On embed-send failure (very rare) retry once as plain text: `💸 Wallet <short addr> moved: https://cardanoscan.io/transaction/<hash>`.

## Rate & resource budget

At an expected ceiling of ~200 distinct watched stake keys:
- Main poll: 1 `/accounts/{stake}/addresses/transactions` per wallet per tick = ~3.3 req/s at 60s interval (well under Blockfrost free-tier 10 req/s).
- `/accounts/{stake}/addresses` fetched once per watcher per 1h TTL (~200 calls/hour on a full refresh cycle).
- Each new tx adds one `/txs/{hash}/utxos` call. Normal activity keeps us under daily caps.

## Error handling summary

| Failure | Behavior |
|---|---|
| Invalid bech32 / wrong network | Ephemeral error; no DB write |
| Blockfrost 404 on `/addresses/{addr}` | Allow add, baseline null, note "no activity yet" |
| Blockfrost 5xx / network error during add | Ephemeral error; no DB write |
| Blockfrost error during poll tick | Logged, skipped; retried next tick |
| DM send fails | 24h `dm_disabled_until` on that subscription; cursor not advanced; log once |
| Bot restart mid-poll | Resume from persisted cursors; backlog >10 collapses to summary DM |
| Two users watch same wallet, one DM fails | Only the failing user cooled down; the other still receives |
| User leaves guild | Subscriptions remain until removed; failed DMs trigger 24h cooldown |
| Missing required env var | `loadConfig()` throws at startup (fail-fast) |
| Chain rollback | Not un-sent. Forward-only cursor. Acceptable for v1 |

## Abuse resistance

- Per-user rate limit: 10 `add` per 60s and 10 `remove` per 60s (separate buckets by `action` column), persisted in `wallet_rate_limit`. `list` is not rate-limited since it's a DB-only read.
- Cap enforcement (6 / 20 by role) in `addWalletWatch`.
- Channel gate: commands elsewhere are ephemerally rejected, don't count against rate limit.
- `/watch list` only ever reads the invoker's own rows; no `user` arg; no admin variant.

## Testing plan (manual; no test harness exists in repo)

- Optional throwaway script: `ts-node scripts/test-wallet-watch.ts` exercising `cardanoAddress.validate()` against fixtures (valid mainnet payment, valid testnet payment, valid stake, enterprise, invalid, empty).
- Live integration smoke:
  1. `/watch add` outside the channel → ephemeral rejection.
  2. Add `addr1…` → stake-normalized confirmation.
  3. Add enterprise addr → warning note.
  4. Add 6 without verified role → 7th rejected.
  5. Grant verified role, fill to 20 → 21st rejected.
  6. Send ADA from watched wallet → DM with `OUT` + Cardanoscan link within ~60s.
  7. Receive ADA → DM with `IN` + delta.
  8. Block bot DMs, trigger move → log shows cooldown, no crash.
  9. `/watch list` → only own list; `/watch remove` works by pasted address or stake key.

## Out of scope for v1

- Label/nickname editing (`label` column reserved but not exposed).
- "Mute for N hours" control.
- Per-category filters (swaps-only, receives-only, etc.).
- Admin dashboard / all-users view.
- Webhook-based polling (Blockfrost webhooks).
- Multi-guild routing — everything keyed off the one configured channel.
