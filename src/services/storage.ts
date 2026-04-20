import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

export interface SeenPolicy {
  policyId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  alertCount: number;
}

export interface TrackedPolicy {
  policyId: string;
  addedBy: string;
  label: string | null;
  addedAt: string;
}

export type PriceSource = 'dexhunter' | 'snek' | null;

export interface PolicyCall {
  policyId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  callerUserId: string;
  callerDisplayName: string;
  calledAt: string;
  callPriceAda: number | null;
  callFdvAda: number | null;
  callUnit: string | null;
  callSource: PriceSource;
}

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

export class StorageService {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    const dir = path.dirname(databasePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_policies (
        policy_id TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        alert_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tracked_policies (
        policy_id TEXT PRIMARY KEY,
        added_by TEXT NOT NULL,
        label TEXT,
        added_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recent_alerts (
        policy_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        alerted_at INTEGER NOT NULL,
        PRIMARY KEY (policy_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS policy_calls (
        policy_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        caller_user_id TEXT NOT NULL,
        caller_display_name TEXT NOT NULL,
        called_at TEXT NOT NULL,
        call_price_ada REAL,
        call_fdv_ada REAL,
        call_unit TEXT,
        call_source TEXT
      );
    `);
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
    // Additive migrations for DBs that pre-date newer columns.
    const columns = this.db.prepare('PRAGMA table_info(policy_calls)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    if (!names.has('call_source')) {
      this.db.prepare('ALTER TABLE policy_calls ADD COLUMN call_source TEXT').run();
    }
    if (!names.has('call_fdv_ada')) {
      this.db.prepare('ALTER TABLE policy_calls ADD COLUMN call_fdv_ada REAL').run();
    }
  }

  /** Records a first-ever call for a policy. INSERT OR IGNORE — only the first caller wins. */
  recordCall(call: PolicyCall): { firstCaller: boolean; record: PolicyCall } {
    const id = call.policyId.toLowerCase();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO policy_calls
           (policy_id, guild_id, channel_id, message_id, caller_user_id, caller_display_name, called_at, call_price_ada, call_fdv_ada, call_unit, call_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        call.guildId,
        call.channelId,
        call.messageId,
        call.callerUserId,
        call.callerDisplayName,
        call.calledAt,
        call.callPriceAda,
        call.callFdvAda,
        call.callUnit,
        call.callSource
      );
    if (result.changes > 0) return { firstCaller: true, record: { ...call, policyId: id } };
    const existing = this.getCall(id);
    return { firstCaller: false, record: existing! };
  }

  getSighting(policyId: string): SeenPolicy | null {
    const id = policyId.toLowerCase();
    const row = this.db
      .prepare(
        'SELECT policy_id AS policyId, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, alert_count AS alertCount FROM seen_policies WHERE policy_id = ?'
      )
      .get(id) as SeenPolicy | undefined;
    return row ?? null;
  }

  getCall(policyId: string): PolicyCall | null {
    const id = policyId.toLowerCase();
    const row = this.db
      .prepare(
        `SELECT policy_id AS policyId, guild_id AS guildId, channel_id AS channelId, message_id AS messageId,
                caller_user_id AS callerUserId, caller_display_name AS callerDisplayName,
                called_at AS calledAt, call_price_ada AS callPriceAda, call_fdv_ada AS callFdvAda,
                call_unit AS callUnit, call_source AS callSource
         FROM policy_calls WHERE policy_id = ?`
      )
      .get(id) as PolicyCall | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }

  /** Returns true if the policy ID is being seen for the first time. */
  recordSighting(policyId: string): { firstSeen: boolean; record: SeenPolicy } {
    const id = policyId.toLowerCase();
    const now = new Date().toISOString();

    const existing = this.db
      .prepare('SELECT policy_id, first_seen_at, last_seen_at, alert_count FROM seen_policies WHERE policy_id = ?')
      .get(id) as
      | { policy_id: string; first_seen_at: string; last_seen_at: string; alert_count: number }
      | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE seen_policies SET last_seen_at = ?, alert_count = alert_count + 1 WHERE policy_id = ?')
        .run(now, id);
      return {
        firstSeen: false,
        record: {
          policyId: id,
          firstSeenAt: existing.first_seen_at,
          lastSeenAt: now,
          alertCount: existing.alert_count + 1,
        },
      };
    }

    this.db
      .prepare(
        'INSERT INTO seen_policies (policy_id, first_seen_at, last_seen_at, alert_count) VALUES (?, ?, ?, 1)'
      )
      .run(id, now, now);
    return {
      firstSeen: true,
      record: { policyId: id, firstSeenAt: now, lastSeenAt: now, alertCount: 1 },
    };
  }

  /** Debounce helper – true if we've already alerted about this policy in the channel recently. */
  isRecentlyAlerted(policyId: string, channelId: string, windowMs: number): boolean {
    const id = policyId.toLowerCase();
    const row = this.db
      .prepare('SELECT alerted_at FROM recent_alerts WHERE policy_id = ? AND channel_id = ?')
      .get(id, channelId) as { alerted_at: number } | undefined;
    if (!row) return false;
    const fresh = Date.now() - row.alerted_at < windowMs;
    if (!fresh) {
      this.db
        .prepare('DELETE FROM recent_alerts WHERE policy_id = ? AND channel_id = ?')
        .run(id, channelId);
    }
    return fresh;
  }

  markAlerted(policyId: string, channelId: string): void {
    const id = policyId.toLowerCase();
    this.db
      .prepare(
        'INSERT INTO recent_alerts (policy_id, channel_id, alerted_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(policy_id, channel_id) DO UPDATE SET alerted_at = excluded.alerted_at'
      )
      .run(id, channelId, Date.now());
  }

  addTrackedPolicy(policyId: string, addedBy: string, label: string | null): TrackedPolicy {
    const id = policyId.toLowerCase();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO tracked_policies (policy_id, added_by, label, added_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(policy_id) DO UPDATE SET added_by = excluded.added_by, label = excluded.label'
      )
      .run(id, addedBy, label, now);
    return { policyId: id, addedBy, label, addedAt: now };
  }

  removeTrackedPolicy(policyId: string): boolean {
    const id = policyId.toLowerCase();
    const result = this.db.prepare('DELETE FROM tracked_policies WHERE policy_id = ?').run(id);
    return result.changes > 0;
  }

  listTrackedPolicies(): TrackedPolicy[] {
    const rows = this.db
      .prepare(
        'SELECT policy_id AS policyId, added_by AS addedBy, label, added_at AS addedAt FROM tracked_policies ORDER BY added_at DESC'
      )
      .all() as TrackedPolicy[];
    return rows;
  }

  isTracked(policyId: string): boolean {
    const id = policyId.toLowerCase();
    const row = this.db.prepare('SELECT 1 FROM tracked_policies WHERE policy_id = ?').get(id);
    return Boolean(row);
  }

  cleanupExpiredAlerts(windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    const res = this.db.prepare('DELETE FROM recent_alerts WHERE alerted_at < ?').run(cutoff);
    if (res.changes > 0) logger.debug(`Cleared ${res.changes} expired alert debounce rows`);
  }

  // ============================================================================
  // Wallet Watch CRUD Methods
  // ============================================================================

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

  addWalletWatch(params: {
    userId: string;
    stakeKey: string;
    displayAddress: string;
    isEnterprise: boolean;
    baselineTxHash: string | null;
    label?: string | null;
  }): WalletWatch {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO wallet_watches
         (discord_user_id, stake_key, display_address, is_enterprise,
          label,
          created_at, last_notified_tx_hash, last_notified_at, dm_disabled_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    );
    const info = stmt.run(
      params.userId,
      params.stakeKey,
      params.displayAddress,
      params.isEnterprise ? 1 : 0,
      params.label ?? null,
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

  // ============================================================================
  // Poll-Driver Methods
  // ============================================================================

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

  // ============================================================================
  // Rate-Limit Methods
  // ============================================================================

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
}
