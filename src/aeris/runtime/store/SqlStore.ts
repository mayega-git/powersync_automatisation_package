import type { AccessLocalDatabase, LocalDatabaseSession } from '../../../core/AccessLocalDatabase.js';
import type { JsonValue, Projection } from '../../ir/types.js';
import {
  applyFind,
  DuplicateKeyError,
  keyString,
  UnknownEntityError,
  type FindOptions,
  type LocalStore,
  type OutboxRecord,
  type ResolvedFilter,
  type StoredRow,
  type StoreTx,
} from './LocalStore.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS aeris_rows (entity TEXT NOT NULL, k TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (entity, k))`,
  `CREATE TABLE IF NOT EXISTS aeris_outbox (operation_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, doc TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS aeris_outbox_seq ON aeris_outbox (seq)`,
  `CREATE TABLE IF NOT EXISTS aeris_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/**
 * Local store on any SQLite reachable through AccessLocalDatabase: PowerSync
 * or wa-sqlite in the browser (OPFS, with IndexedDB VFS fallback),
 * better-sqlite3 in Node. Rows are kept as JSON documents and filtered with
 * the shared matcher, so every store implementation has identical semantics.
 */
export class SqlStore implements LocalStore {
  private keys = new Map<string, string>();
  private ready = false;

  constructor(private readonly db: AccessLocalDatabase) {}

  async open(projections: readonly Projection[]): Promise<void> {
    if (!this.ready) {
      for (const statement of SCHEMA) await this.db.writeData(statement);
      this.ready = true;
    }
    for (const projection of projections) this.keys.set(projection.entity, projection.key);
  }

  transaction<T>(work: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.db.runInTransaction((session) => work(new SqlTx(session, this.keys)));
  }

  async purge(): Promise<void> {
    await this.db.runInTransaction(async (session) => {
      await session.writeData('DELETE FROM aeris_rows');
      await session.writeData('DELETE FROM aeris_outbox');
      await session.writeData('DELETE FROM aeris_meta');
    });
  }
}

class SqlTx implements StoreTx {
  constructor(private readonly session: LocalDatabaseSession, private readonly keys: ReadonlyMap<string, string>) {}

  private keyOf(entity: string): string {
    const key = this.keys.get(entity);
    if (key === undefined) throw new UnknownEntityError(entity);
    return key;
  }

  async get(entity: string, key: JsonValue): Promise<StoredRow | null> {
    this.keyOf(entity);
    const rows = await this.session.readData<{ doc: string }>(
      'SELECT doc FROM aeris_rows WHERE entity = ? AND k = ?',
      [entity, keyString(key)],
    );
    return rows[0] === undefined ? null : JSON.parse(rows[0].doc) as StoredRow;
  }

  async all(entity: string): Promise<StoredRow[]> {
    this.keyOf(entity);
    const rows = await this.session.readData<{ doc: string }>(
      'SELECT doc FROM aeris_rows WHERE entity = ? ORDER BY k',
      [entity],
    );
    return rows.map((row) => JSON.parse(row.doc) as StoredRow);
  }

  async find(entity: string, where: readonly ResolvedFilter[], options?: FindOptions): Promise<StoredRow[]> {
    const key = this.keyOf(entity);
    const byKey = where.find((filter) => filter.field === key && filter.cmp === 'eq' && filter.value !== null && filter.value !== undefined);
    const candidates = byKey === undefined
      ? await this.all(entity)
      : [await this.get(entity, byKey.value!)].filter((row): row is StoredRow => row !== null);
    return applyFind(candidates, where, options, key);
  }

  async insert(entity: string, row: StoredRow): Promise<void> {
    const keyValue = row[this.keyOf(entity)] ?? null;
    if (await this.get(entity, keyValue) !== null) throw new DuplicateKeyError(entity, keyValue);
    await this.session.writeData('INSERT INTO aeris_rows (entity, k, doc) VALUES (?, ?, ?)', [entity, keyString(keyValue), JSON.stringify(row)]);
  }

  async put(entity: string, row: StoredRow): Promise<void> {
    const keyValue = row[this.keyOf(entity)] ?? null;
    await this.session.writeData(
      'INSERT INTO aeris_rows (entity, k, doc) VALUES (?, ?, ?) ON CONFLICT (entity, k) DO UPDATE SET doc = excluded.doc',
      [entity, keyString(keyValue), JSON.stringify(row)],
    );
  }

  async update(entity: string, key: JsonValue, values: StoredRow): Promise<StoredRow | null> {
    const existing = await this.get(entity, key);
    if (existing === null) return null;
    const next = { ...existing, ...values };
    const newKey = next[this.keyOf(entity)] ?? null;
    if (keyString(newKey) !== keyString(key)) {
      if (await this.get(entity, newKey) !== null) throw new DuplicateKeyError(entity, newKey);
      await this.delete(entity, key);
      await this.insert(entity, next);
    } else {
      await this.session.writeData('UPDATE aeris_rows SET doc = ? WHERE entity = ? AND k = ?', [JSON.stringify(next), entity, keyString(key)]);
    }
    return next;
  }

  async delete(entity: string, key: JsonValue): Promise<boolean> {
    this.keyOf(entity);
    const existed = await this.get(entity, key) !== null;
    if (existed) await this.session.writeData('DELETE FROM aeris_rows WHERE entity = ? AND k = ?', [entity, keyString(key)]);
    return existed;
  }

  async clear(entity: string): Promise<void> {
    await this.session.writeData('DELETE FROM aeris_rows WHERE entity = ?', [entity]);
  }

  async outboxPut(record: OutboxRecord): Promise<void> {
    await this.session.writeData(
      'INSERT INTO aeris_outbox (operation_id, seq, doc) VALUES (?, ?, ?) ON CONFLICT (operation_id) DO UPDATE SET seq = excluded.seq, doc = excluded.doc',
      [record.operationId, record.sequence, JSON.stringify(record)],
    );
  }

  async outboxGet(operationId: string): Promise<OutboxRecord | null> {
    const rows = await this.session.readData<{ doc: string }>('SELECT doc FROM aeris_outbox WHERE operation_id = ?', [operationId]);
    return rows[0] === undefined ? null : JSON.parse(rows[0].doc) as OutboxRecord;
  }

  async outboxList(): Promise<OutboxRecord[]> {
    const rows = await this.session.readData<{ doc: string }>('SELECT doc FROM aeris_outbox ORDER BY seq');
    return rows.map((row) => JSON.parse(row.doc) as OutboxRecord);
  }

  async outboxDelete(operationId: string): Promise<void> {
    await this.session.writeData('DELETE FROM aeris_outbox WHERE operation_id = ?', [operationId]);
  }

  async metaGet(key: string): Promise<JsonValue | undefined> {
    const rows = await this.session.readData<{ value: string }>('SELECT value FROM aeris_meta WHERE key = ?', [key]);
    return rows[0] === undefined ? undefined : JSON.parse(rows[0].value) as JsonValue;
  }

  async metaSet(key: string, value: JsonValue | undefined): Promise<void> {
    if (value === undefined) await this.session.writeData('DELETE FROM aeris_meta WHERE key = ?', [key]);
    else {
      await this.session.writeData(
        'INSERT INTO aeris_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(value)],
      );
    }
  }
}
