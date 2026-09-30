import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDeliveryStore, DEDUPE_WINDOW_SECONDS } from '../src/dedupe';

describe('openDeliveryStore', () => {
  let dbPath: string;
  let clock: number;
  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-')), 'state', 'deliveries.db');
    clock = 1_800_000_000;
  });

  it('flags a delivery id as duplicate only within the 24h window', () => {
    const store = openDeliveryStore(dbPath, () => clock);
    expect(store.checkAndRecord('abc-123')).toBe(false);
    expect(store.checkAndRecord('abc-123')).toBe(true);
    expect(store.checkAndRecord('other')).toBe(false);

    clock += DEDUPE_WINDOW_SECONDS + 1;
    expect(store.checkAndRecord('abc-123')).toBe(false);
    expect(store.checkAndRecord('abc-123')).toBe(true);
    store.close();
  });

  it('survives a restart (state lives in the SQLite file)', () => {
    const first = openDeliveryStore(dbPath, () => clock);
    first.checkAndRecord('abc-123');
    first.close();

    const second = openDeliveryStore(dbPath, () => clock);
    expect(second.checkAndRecord('abc-123')).toBe(true);
    second.close();
  });

  it('forget() lets the same id through again', () => {
    const store = openDeliveryStore(dbPath, () => clock);
    store.checkAndRecord('abc-123');
    store.forget('abc-123');
    expect(store.checkAndRecord('abc-123')).toBe(false);
    store.close();
  });

  it('prunes expired rows on insert', () => {
    const store = openDeliveryStore(dbPath, () => clock);
    store.checkAndRecord('old');
    clock += DEDUPE_WINDOW_SECONDS + 1;
    store.checkAndRecord('new');
    store.close();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const ids = db.prepare('SELECT delivery_id FROM deliveries').all().map((r: { delivery_id: string }) => r.delivery_id);
    db.close();
    expect(ids).toEqual(['new']);
  });
});
