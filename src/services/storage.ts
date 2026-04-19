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
    `);
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
}
