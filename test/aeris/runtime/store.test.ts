import 'fake-indexeddb/auto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { BetterSqliteDatabase } from '../../../src/aeris/runtime/store/BetterSqliteDatabase.js';
import { IndexedDbStore } from '../../../src/aeris/runtime/store/IndexedDbStore.js';
import { DuplicateKeyError, type LocalStore } from '../../../src/aeris/runtime/store/LocalStore.js';
import { MemoryStore } from '../../../src/aeris/runtime/store/MemoryStore.js';
import { SqlStore } from '../../../src/aeris/runtime/store/SqlStore.js';
import { ENTITY, projection } from './fixtures.js';

let counter = 0;
const stores: [string, () => LocalStore][] = [
  ['memory', () => new MemoryStore()],
  ['sqlite', () => new SqlStore(new BetterSqliteDatabase(new Database(':memory:')))],
  ['indexeddb', () => new IndexedDbStore(indexedDB, `aeris-test-${counter++}`)],
];

const row = (id: string, name: string | null, extra: Record<string, unknown> = {}) => ({
  id, organizationId: 'org', agencyId: null, salesPointName: name, status: 'ACTIVE', currency: 'XAF',
  createdAt: '2026-10-05T10:00:00.5', updatedAt: '2026-10-05T10:00:00.5', ...extra,
});

describe.each(stores)('%s store conformance', (_name, create) => {
  it('stores, queries with SQL null semantics, orders with NULLS LAST and limits', async () => {
    const store = create();
    await store.open([projection]);
    await store.transaction(async (tx) => {
      await tx.insert(ENTITY, row('A0000000-0000-4000-8000-000000000001', 'beta'));
      await tx.insert(ENTITY, row('a0000000-0000-4000-8000-000000000002', 'alpha', { createdAt: '2026-10-05T10:00:00.25' }));
      await tx.insert(ENTITY, row('a0000000-0000-4000-8000-000000000003', null));
    });
    const result = await store.transaction(async (tx) => ({
      byKey: await tx.get(ENTITY, 'a0000000-0000-4000-8000-000000000001'),
      ordered: (await tx.find(ENTITY, [], { orderBy: [{ field: 'salesPointName', dir: 'asc' }] })).map((r) => r.salesPointName),
      descending: (await tx.find(ENTITY, [], { orderBy: [{ field: 'salesPointName', dir: 'desc' }] })).map((r) => r.salesPointName),
      nullEq: (await tx.find(ENTITY, [{ field: 'salesPointName', cmp: 'eq', value: null }])).length,
      neNull: (await tx.find(ENTITY, [{ field: 'salesPointName', cmp: 'ne', value: 'beta' }])).length,
      before: (await tx.find(ENTITY, [{ field: 'createdAt', cmp: 'lt', value: '2026-10-05T10:00:00.3' }])).length,
      limited: (await tx.find(ENTITY, [], { limit: 2 })).length,
      inList: (await tx.find(ENTITY, [{ field: 'salesPointName', cmp: 'in', value: ['alpha', 'zeta'] }])).length,
    }));
    expect(result.byKey?.salesPointName).toBe('beta');
    expect(result.ordered).toEqual(['alpha', 'beta', null]);
    expect(result.descending).toEqual([null, 'beta', 'alpha']);
    expect(result.nullEq).toBe(1);
    expect(result.neNull).toBe(1);
    expect(result.before).toBe(1);
    expect(result.limited).toBe(2);
    expect(result.inList).toBe(1);
  });

  it('rolls back every write, including the outbox, when the transaction throws', async () => {
    const store = create();
    await store.open([projection]);
    await expect(store.transaction(async (tx) => {
      await tx.insert(ENTITY, row('b0000000-0000-4000-8000-000000000001', 'x'));
      await tx.outboxPut({ operationId: 'op-1', sequence: 1 });
      await tx.metaSet('cursor', '42');
      throw new Error('crash between mutation and commit');
    })).rejects.toThrow('crash');
    const after = await store.transaction(async (tx) => ({
      rows: await tx.all(ENTITY),
      outbox: await tx.outboxList(),
      cursor: await tx.metaGet('cursor'),
    }));
    expect(after).toEqual({ rows: [], outbox: [], cursor: undefined });
  });

  it('rejects duplicate keys, updates by key, re-keys and purges', async () => {
    const store = create();
    await store.open([projection]);
    await store.transaction((tx) => tx.insert(ENTITY, row('c0000000-0000-4000-8000-000000000001', 'x')));
    await expect(store.transaction((tx) => tx.insert(ENTITY, row('C0000000-0000-4000-8000-000000000001', 'y')))).rejects.toBeInstanceOf(DuplicateKeyError);
    await store.transaction(async (tx) => {
      expect(await tx.update(ENTITY, 'c0000000-0000-4000-8000-000000000001', { salesPointName: 'renamed' })).toMatchObject({ salesPointName: 'renamed' });
      expect(await tx.update(ENTITY, 'c0000000-0000-4000-8000-00000000ffff', { salesPointName: 'x' })).toBeNull();
      await tx.outboxPut({ operationId: 'op-2', sequence: 2 });
      await tx.outboxPut({ operationId: 'op-1', sequence: 1 });
    });
    const outbox = await store.transaction((tx) => tx.outboxList());
    expect(outbox.map((entry) => entry.operationId)).toEqual(['op-1', 'op-2']);
    await store.purge();
    expect(await store.transaction(async (tx) => [(await tx.all(ENTITY)).length, (await tx.outboxList()).length])).toEqual([0, 0]);
  });
});
