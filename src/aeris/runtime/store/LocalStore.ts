import type { FilterCmp, JsonValue, OrderBy, Projection } from '../../ir/types.js';
import { compareValues, isUuid, valuesEqual } from '../values.js';

export type StoredRow = Record<string, JsonValue>;

export interface ResolvedFilter {
  field: string;
  cmp: FilterCmp;
  /** Evaluated value; an array for `in`. */
  value?: JsonValue;
}

export interface FindOptions {
  orderBy?: readonly OrderBy[];
  limit?: number;
}

/** A durable record of one local operation (see outbox.ts). Stored as an opaque document. */
export interface OutboxRecord {
  operationId: string;
  sequence: number;
  [field: string]: JsonValue;
}

/**
 * One transaction over the local data plane. Projection rows and the outbox
 * live in the same store so a mutation and its journal entry commit or roll
 * back together (architecture invariant D).
 */
export interface StoreTx {
  get(entity: string, key: JsonValue): Promise<StoredRow | null>;
  find(entity: string, where: readonly ResolvedFilter[], options?: FindOptions): Promise<StoredRow[]>;
  /** Fails with DuplicateKeyError when the key exists. */
  insert(entity: string, row: StoredRow): Promise<void>;
  /** Insert or replace, used by snapshots, deltas and receipts. */
  put(entity: string, row: StoredRow): Promise<void>;
  /** Merges `values` into the row; returns null when no row has this key. */
  update(entity: string, key: JsonValue, values: StoredRow): Promise<StoredRow | null>;
  delete(entity: string, key: JsonValue): Promise<boolean>;
  clear(entity: string): Promise<void>;
  /** Every row of an entity, in key order. */
  all(entity: string): Promise<StoredRow[]>;

  outboxPut(record: OutboxRecord): Promise<void>;
  outboxGet(operationId: string): Promise<OutboxRecord | null>;
  /** In sequence order. */
  outboxList(): Promise<OutboxRecord[]>;
  outboxDelete(operationId: string): Promise<void>;

  metaGet(key: string): Promise<JsonValue | undefined>;
  metaSet(key: string, value: JsonValue | undefined): Promise<void>;
}

export interface LocalStore {
  /** Prepares storage for these projections. Safe to call repeatedly. */
  open(projections: readonly Projection[]): Promise<void>;
  /** Runs `work` atomically; a thrown error rolls everything back. */
  transaction<T>(work: (tx: StoreTx) => Promise<T>): Promise<T>;
  /** Erases every projection, the outbox and metadata (logout, user switch). */
  purge(): Promise<void>;
  close?(): Promise<void>;
}

export class DuplicateKeyError extends Error {
  constructor(entity: string, key: JsonValue) {
    super(`A ${entity} row with key ${JSON.stringify(key)} already exists.`);
    this.name = 'DuplicateKeyError';
  }
}

export class UnknownEntityError extends Error {
  constructor(entity: string) {
    super(`No local projection for entity ${entity}.`);
    this.name = 'UnknownEntityError';
  }
}

/** Stable string form of a primary key, used as the storage key. */
export function keyString(value: JsonValue): string {
  if (value === null || value === undefined) throw new Error('A primary key cannot be null.');
  if (typeof value === 'string') return isUuid(value) ? value.toLowerCase() : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Filter semantics of Spring Data derived queries over SQL:
 * - `eq null` means IS NULL, `ne null` means IS NOT NULL;
 * - a comparison with NULL on either side is unknown, hence false;
 * - `in` with an empty list matches nothing.
 */
export function matchesFilters(row: StoredRow, where: readonly ResolvedFilter[]): boolean {
  for (const filter of where) {
    const actual = row[filter.field] ?? null;
    const expected = filter.value ?? null;
    switch (filter.cmp) {
      case 'isNull':
        if (actual !== null) return false;
        break;
      case 'notNull':
        if (actual === null) return false;
        break;
      case 'eq':
        if (expected === null ? actual !== null : actual === null || !valuesEqual(actual, expected)) return false;
        break;
      case 'ne':
        if (expected === null ? actual === null : actual === null || valuesEqual(actual, expected)) return false;
        break;
      case 'in':
        if (actual === null || !Array.isArray(expected) || !expected.some((item) => item !== null && valuesEqual(actual, item))) return false;
        break;
      default: {
        if (actual === null || expected === null) return false;
        const order = compareValues(actual, expected);
        if (order === null) return false;
        if (filter.cmp === 'lt' && !(order < 0)) return false;
        if (filter.cmp === 'le' && !(order <= 0)) return false;
        if (filter.cmp === 'gt' && !(order > 0)) return false;
        if (filter.cmp === 'ge' && !(order >= 0)) return false;
      }
    }
  }
  return true;
}

/** ORDER BY with PostgreSQL null placement: NULLS LAST ascending, NULLS FIRST descending. */
export function sortRows(rows: StoredRow[], orderBy: readonly OrderBy[] | undefined, key: string): StoredRow[] {
  const orders = [...(orderBy ?? []), { field: key, dir: 'asc' as const }];
  return rows.sort((left, right) => {
    for (const { field, dir } of orders) {
      const a = left[field] ?? null;
      const b = right[field] ?? null;
      if (a === null && b === null) continue;
      if (a === null) return dir === 'asc' ? 1 : -1;
      if (b === null) return dir === 'asc' ? -1 : 1;
      const order = compareValues(a, b) ?? 0;
      if (order !== 0) return dir === 'asc' ? order : -order;
    }
    return 0;
  });
}

export function applyFind(rows: StoredRow[], where: readonly ResolvedFilter[], options: FindOptions | undefined, key: string): StoredRow[] {
  const matched = sortRows(rows.filter((row) => matchesFilters(row, where)), options?.orderBy, key);
  return options?.limit === undefined ? matched : matched.slice(0, options.limit);
}

/** Storage name for a projection's table, unique per (schema, table). */
export function storageName(projection: Pick<Projection, 'schema' | 'table'>): string {
  return `aeris_p_${projection.schema === undefined ? '' : `${projection.schema}__`}${projection.table}`;
}
