import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Replay protection: remembers `X-GitHub-Delivery` ids for 24h in a tiny
 * SQLite file (default `workspace/state/deliveries.db`) so a receiver restart
 * doesn't reopen the replay window the way an in-memory set would.
 */

export const DEDUPE_WINDOW_SECONDS = 24 * 60 * 60;

export interface DeliveryStore {
  /**
   * Record `deliveryId` as seen. Returns true if it was already seen inside
   * the 24h window (a replay), false if this is its first occurrence.
   */
  checkAndRecord(deliveryId: string): boolean;
  /** Drop a recorded id, so GitHub's redelivery of a request we failed to process isn't treated as a replay. */
  forget(deliveryId: string): void;
  close(): void;
}

/** `nowSeconds` is injectable so tests can move the clock past the window. */
export function openDeliveryStore(
  dbPath: string,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): DeliveryStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS deliveries (delivery_id TEXT PRIMARY KEY, seen_at INTEGER)');

  // Expired rows are pruned on every insert (the table stays tiny), so an id
  // older than the window no longer blocks — INSERT OR IGNORE then succeeds.
  const prune = db.prepare('DELETE FROM deliveries WHERE seen_at < ?');
  const insert = db.prepare('INSERT OR IGNORE INTO deliveries (delivery_id, seen_at) VALUES (?, ?)');
  const remove = db.prepare('DELETE FROM deliveries WHERE delivery_id = ?');

  const checkAndRecord = db.transaction((deliveryId: string): boolean => {
    const now = nowSeconds();
    prune.run(now - DEDUPE_WINDOW_SECONDS);
    return insert.run(deliveryId, now).changes === 0;
  });

  return {
    checkAndRecord,
    forget: deliveryId => {
      remove.run(deliveryId);
    },
    close: () => db.close(),
  };
}
