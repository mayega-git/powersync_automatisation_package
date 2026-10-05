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

const VERSION = 1;
const ROWS = 'rows';
const OUTBOX = 'outbox';
const META = 'meta';

/**
 * IndexedDB fallback for browsers where SQLite/OPFS is unavailable. One
 * readwrite transaction spans rows, outbox and metadata, so a mutation and
 * its journal entry are atomic.
 *
 * Constraint inherited from IndexedDB: the transaction auto-commits as soon
 * as no request is pending, so the work callback must only await operations
 * of this transaction (the executor and the sync engine respect this).
 */
export class IndexedDbStore implements LocalStore {
  private db: IDBDatabase | undefined;
  private keys = new Map<string, string>();

  constructor(private readonly factory: IDBFactory, private readonly name = 'aeris') {}

  async open(projections: readonly Projection[]): Promise<void> {
    if (this.db === undefined) {
      this.db = await request(openDatabase(this.factory, this.name));
    }
    for (const projection of projections) this.keys.set(projection.entity, projection.key);
  }

  async transaction<T>(work: (tx: StoreTx) => Promise<T>): Promise<T> {
    const db = this.database();
    const transaction = db.transaction([ROWS, OUTBOX, META], 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    });
    let result: T;
    try {
      result = await work(new IdbTx(transaction, this.keys));
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Already finished; the original error is what matters.
      }
      await done.catch(() => undefined);
      throw error;
    }
    await done;
    return result;
  }

  async purge(): Promise<void> {
    await this.transaction(async () => undefined);
    const transaction = this.database().transaction([ROWS, OUTBOX, META], 'readwrite');
    transaction.objectStore(ROWS).clear();
    transaction.objectStore(OUTBOX).clear();
    transaction.objectStore(META).clear();
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  private database(): IDBDatabase {
    if (this.db === undefined) throw new Error('IndexedDbStore.open() must be called first.');
    return this.db;
  }
}

function openDatabase(factory: IDBFactory, name: string): IDBOpenDBRequest {
  const open = factory.open(name, VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(ROWS)) {
      const rows = db.createObjectStore(ROWS, { keyPath: ['entity', 'k'] });
      rows.createIndex('entity', 'entity');
    }
    if (!db.objectStoreNames.contains(OUTBOX)) {
      const outbox = db.createObjectStore(OUTBOX, { keyPath: 'operationId' });
      outbox.createIndex('sequence', 'sequence');
    }
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
  };
  return open;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

interface RowEnvelope {
  entity: string;
  k: string;
  doc: StoredRow;
}

class IdbTx implements StoreTx {
  constructor(private readonly tx: IDBTransaction, private readonly keys: ReadonlyMap<string, string>) {}

  private keyOf(entity: string): string {
    const key = this.keys.get(entity);
    if (key === undefined) throw new UnknownEntityError(entity);
    return key;
  }

  private rows(): IDBObjectStore {
    return this.tx.objectStore(ROWS);
  }

  async get(entity: string, key: JsonValue): Promise<StoredRow | null> {
    this.keyOf(entity);
    const envelope = await request<RowEnvelope | undefined>(this.rows().get([entity, keyString(key)]));
    return envelope === undefined ? null : envelope.doc;
  }

  async all(entity: string): Promise<StoredRow[]> {
    this.keyOf(entity);
    const envelopes = await request<RowEnvelope[]>(this.rows().index('entity').getAll(entity));
    return envelopes.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map((envelope) => envelope.doc);
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
    await request(this.rows().add({ entity, k: keyString(keyValue), doc: row } satisfies RowEnvelope));
  }

  async put(entity: string, row: StoredRow): Promise<void> {
    const keyValue = row[this.keyOf(entity)] ?? null;
    await request(this.rows().put({ entity, k: keyString(keyValue), doc: row } satisfies RowEnvelope));
  }

  async update(entity: string, key: JsonValue, values: StoredRow): Promise<StoredRow | null> {
    const existing = await this.get(entity, key);
    if (existing === null) return null;
    const next = { ...existing, ...values };
    const newKey = next[this.keyOf(entity)] ?? null;
    if (keyString(newKey) !== keyString(key)) {
      if (await this.get(entity, newKey) !== null) throw new DuplicateKeyError(entity, newKey);
      await this.delete(entity, key);
    }
    await this.put(entity, next);
    return next;
  }

  async delete(entity: string, key: JsonValue): Promise<boolean> {
    const existed = await this.get(entity, key) !== null;
    if (existed) await request(this.rows().delete([entity, keyString(key)]));
    return existed;
  }

  async clear(entity: string): Promise<void> {
    const keys = await request(this.rows().index('entity').getAllKeys(entity));
    for (const key of keys) await request(this.rows().delete(key));
  }

  async outboxPut(record: OutboxRecord): Promise<void> {
    await request(this.tx.objectStore(OUTBOX).put(record));
  }

  async outboxGet(operationId: string): Promise<OutboxRecord | null> {
    return (await request<OutboxRecord | undefined>(this.tx.objectStore(OUTBOX).get(operationId))) ?? null;
  }

  async outboxList(): Promise<OutboxRecord[]> {
    return request<OutboxRecord[]>(this.tx.objectStore(OUTBOX).index('sequence').getAll());
  }

  async outboxDelete(operationId: string): Promise<void> {
    await request(this.tx.objectStore(OUTBOX).delete(operationId));
  }

  async metaGet(key: string): Promise<JsonValue | undefined> {
    const entry = await request<{ key: string; value: JsonValue } | undefined>(this.tx.objectStore(META).get(key));
    return entry?.value;
  }

  async metaSet(key: string, value: JsonValue | undefined): Promise<void> {
    if (value === undefined) await request(this.tx.objectStore(META).delete(key));
    else await request(this.tx.objectStore(META).put({ key, value }));
  }
}
