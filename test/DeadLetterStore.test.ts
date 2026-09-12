import { describe, expect, it, vi } from 'vitest';

import type {
  AccessLocalDatabase,
  SqlValue,
  WriteResult,
} from '../src/core/AccessLocalDatabase.js';
import {
  DEAD_LETTER_TABLE_NAME,
  DeadLetterStore,
  type DeadLetterEntry,
} from '../src/core/DeadLetterStore.js';

/** Local database simulated by a plain list: checks both the SQL and the effect. */
function fakeDb() {
  const rows: Record<string, SqlValue>[] = [];
  const sqls: string[] = [];

  const db: AccessLocalDatabase = {
    async readData<T>(sql: string): Promise<T[]> {
      sqls.push(sql);
      if (sql.includes('COUNT(*)')) return [{ n: rows.length }] as T[];
      return [...rows].sort(
        (a, b) => Number(b['created_at']) - Number(a['created_at']),
      ) as T[];
    },
    async writeData(sql: string, params?: readonly SqlValue[]): Promise<WriteResult> {
      sqls.push(sql);
      const p = params ?? [];
      if (sql.includes('DELETE')) {
        const i = rows.findIndex((r) => r['id'] === p[0]);
        if (i >= 0) rows.splice(i, 1);
        return { rows: [], rowsAffected: 1 };
      }
      const existing = rows.findIndex((r) => r['id'] === p[0]);
      const row = {
        id: p[0]!,
        operation_id: p[1]!,
        payload: p[2]!,
        code: p[3]!,
        reason: p[4]!,
        created_at: p[5]!,
      };
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
      return { rows: [], rowsAffected: 1 };
    },
    async runInTransaction(work) {
      return work(db);
    },
  };
  return { db, rows, sqls };
}

function entry(over: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    id: 'crud-1',
    operationId: 'createBlog',
    payload: '{"title":"a"}',
    code: 422,
    reason: 'missing title',
    createdAt: 1_000,
    ...over,
  };
}

describe('DeadLetterStore', () => {
  it('records an entry and reads it back', async () => {
    const { db } = fakeDb();
    const store = new DeadLetterStore({ db });

    await store.record(entry());
    expect(await store.list()).toEqual([entry()]);
  });

  it('creates no duplicate when the same entry comes back', async () => {
    // Real case: ANOTHER write of the same transaction asks for a retry, the
    // engine replays the whole transaction, and this one comes through again.
    const { db } = fakeDb();
    const store = new DeadLetterStore({ db });

    await store.record(entry());
    await store.record(entry());
    await store.record(entry({ reason: 'missing title (2nd attempt)' }));

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe('missing title (2nd attempt)');
  });

  it('returns entries from the most recent to the oldest', async () => {
    const { db } = fakeDb();
    const store = new DeadLetterStore({ db });

    await store.record(entry({ id: 'a', createdAt: 100 }));
    await store.record(entry({ id: 'b', createdAt: 300 }));
    await store.record(entry({ id: 'c', createdAt: 200 }));

    expect((await store.list()).map((f) => f.id)).toEqual(['b', 'c', 'a']);
  });

  it('removes one entry on request, and only that one', async () => {
    const { db } = fakeDb();
    const store = new DeadLetterStore({ db });
    await store.record(entry({ id: 'a' }));
    await store.record(entry({ id: 'b' }));

    await store.remove('a');
    expect((await store.list()).map((f) => f.id)).toEqual(['b']);
  });

  it('counts entries', async () => {
    const { db } = fakeDb();
    const store = new DeadLetterStore({ db });
    expect(await store.count()).toBe(0);

    await store.record(entry());
    expect(await store.count()).toBe(1);
  });

  it('binds values as parameters, never concatenating them into the SQL', async () => {
    // Otherwise content containing a quote would break the query -- or worse.
    const { db } = fakeDb();
    const write = vi.spyOn(db, 'writeData');
    const store = new DeadLetterStore({ db });

    await store.record(entry({ payload: "{\"title\":\"it's\"}" }));

    const [sql, params] = write.mock.calls[0]!;
    expect(sql).not.toContain("it's");
    expect(params).toContain("{\"title\":\"it's\"}");
  });

  it('uses the default table name', async () => {
    const { db, sqls } = fakeDb();
    await new DeadLetterStore({ db }).record(entry());

    expect(sqls[0]).toContain(DEAD_LETTER_TABLE_NAME);
  });

  it('accepts a different table name', async () => {
    const { db, sqls } = fakeDb();
    await new DeadLetterStore({ db, tableName: 'other_dead_letters' }).record(entry());

    expect(sqls[0]).toContain('other_dead_letters');
  });

  it('refuses a table name that cannot be bound as a parameter', () => {
    // A table name is written into the SQL itself: it can't travel as a
    // value, so its shape is checked at construction.
    const { db } = fakeDb();

    expect(() => new DeadLetterStore({ db, tableName: 'x; DROP TABLE y' })).toThrow(
      /Invalid table name/,
    );
    expect(() => new DeadLetterStore({ db, tableName: '2tables' })).toThrow();
    expect(() => new DeadLetterStore({ db, tableName: '' })).toThrow();
  });

  it('reads back usable types, not raw columns', async () => {
    const { db, rows } = fakeDb();
    // The engine can return numbers as text.
    rows.push({
      id: 'a',
      operation_id: 'createBlog',
      payload: '{}',
      code: '500',
      reason: 'failure',
      created_at: '1700',
    });

    const [entryRow] = await new DeadLetterStore({ db }).list();
    expect(entryRow?.code).toBe(500);
    expect(entryRow?.createdAt).toBe(1700);
  });
});
