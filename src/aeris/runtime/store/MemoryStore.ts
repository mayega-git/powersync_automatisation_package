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

interface State {
  rows: Map<string, Map<string, StoredRow>>;
  outbox: Map<string, OutboxRecord>;
  meta: Map<string, JsonValue>;
}

/**
 * In-memory store with real transaction semantics (copy on begin, swap on
 * commit, serialized writers). Used by tests, by the build-time executor and
 * by shadow execution, which must never touch durable state.
 */
export class MemoryStore implements LocalStore {
  private state: State = { rows: new Map(), outbox: new Map(), meta: new Map() };
  private keys = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  async open(projections: readonly Projection[]): Promise<void> {
    for (const projection of projections) {
      this.keys.set(projection.entity, projection.key);
      if (!this.state.rows.has(projection.entity)) this.state.rows.set(projection.entity, new Map());
    }
  }

  transaction<T>(work: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = clone(this.state);
      const result = await work(new MemoryTx(draft, this.keys));
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  purge(): Promise<void> {
    const run = this.queue.then(() => {
      this.state = {
        rows: new Map([...this.state.rows.keys()].map((entity) => [entity, new Map()])),
        outbox: new Map(),
        meta: new Map(),
      };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function clone(state: State): State {
  return {
    rows: new Map([...state.rows].map(([entity, rows]) => [entity, new Map(rows)])),
    outbox: new Map(state.outbox),
    meta: new Map(state.meta),
  };
}

class MemoryTx implements StoreTx {
  constructor(private readonly state: State, private readonly keys: ReadonlyMap<string, string>) {}

  private table(entity: string): Map<string, StoredRow> {
    const table = this.state.rows.get(entity);
    if (table === undefined) throw new UnknownEntityError(entity);
    return table;
  }

  private keyOf(entity: string): string {
    const key = this.keys.get(entity);
    if (key === undefined) throw new UnknownEntityError(entity);
    return key;
  }

  async get(entity: string, key: JsonValue): Promise<StoredRow | null> {
    const row = this.table(entity).get(keyString(key));
    return row === undefined ? null : structuredClone(row);
  }

  async find(entity: string, where: readonly ResolvedFilter[], options?: FindOptions): Promise<StoredRow[]> {
    return applyFind([...this.table(entity).values()], where, options, this.keyOf(entity)).map((row) => structuredClone(row));
  }

  async all(entity: string): Promise<StoredRow[]> {
    return this.find(entity, []);
  }

  async insert(entity: string, row: StoredRow): Promise<void> {
    const key = keyString(row[this.keyOf(entity)] ?? null);
    const table = this.table(entity);
    if (table.has(key)) throw new DuplicateKeyError(entity, row[this.keyOf(entity)] ?? null);
    table.set(key, structuredClone(row));
  }

  async put(entity: string, row: StoredRow): Promise<void> {
    this.table(entity).set(keyString(row[this.keyOf(entity)] ?? null), structuredClone(row));
  }

  async update(entity: string, key: JsonValue, values: StoredRow): Promise<StoredRow | null> {
    const table = this.table(entity);
    const id = keyString(key);
    const existing = table.get(id);
    if (existing === undefined) return null;
    const next = { ...existing, ...structuredClone(values) };
    const newKey = keyString(next[this.keyOf(entity)] ?? null);
    if (newKey !== id) {
      if (table.has(newKey)) throw new DuplicateKeyError(entity, next[this.keyOf(entity)] ?? null);
      table.delete(id);
    }
    table.set(newKey, next);
    return structuredClone(next);
  }

  async delete(entity: string, key: JsonValue): Promise<boolean> {
    return this.table(entity).delete(keyString(key));
  }

  async clear(entity: string): Promise<void> {
    this.table(entity).clear();
  }

  async outboxPut(record: OutboxRecord): Promise<void> {
    this.state.outbox.set(record.operationId, structuredClone(record));
  }

  async outboxGet(operationId: string): Promise<OutboxRecord | null> {
    const record = this.state.outbox.get(operationId);
    return record === undefined ? null : structuredClone(record);
  }

  async outboxList(): Promise<OutboxRecord[]> {
    return [...this.state.outbox.values()].sort((a, b) => a.sequence - b.sequence).map((record) => structuredClone(record));
  }

  async outboxDelete(operationId: string): Promise<void> {
    this.state.outbox.delete(operationId);
  }

  async metaGet(key: string): Promise<JsonValue | undefined> {
    const value = this.state.meta.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async metaSet(key: string, value: JsonValue | undefined): Promise<void> {
    if (value === undefined) this.state.meta.delete(key);
    else this.state.meta.set(key, structuredClone(value));
  }
}
